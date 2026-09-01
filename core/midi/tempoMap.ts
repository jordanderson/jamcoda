import type { MidiData, MidiEvent } from 'midi-file';

/**
 * Tick-to-seconds conversion for Standard MIDI Files.
 *
 * `@tonejs/midi` used to do this for us. Decoding notes ourselves (so that
 * All Notes Off is honoured -- see `noteSequence.ts`) means owning the time
 * base too.
 */

/** 120 BPM. What the SMF spec says to assume when a file declares no tempo. */
const DEFAULT_MICROSECONDS_PER_BEAT = 500_000;

const TEMPO_MATCH_EPSILON = 1;

interface TempoChange {
  tick: number;
  microsecondsPerBeat: number;
  /** Seconds elapsed from the start of the file to `tick`. */
  seconds: number;
}

export interface TempoMap {
  /**
   * Seconds per tick for files that divide time by SMPTE frames rather than
   * by beats. Tempo events do not apply to those, so `changes` is empty.
   */
  fixedSecondsPerTick: number | null;
  /** Sorted by tick and always starting at tick 0. Empty when SMPTE. */
  changes: TempoChange[];
  ticksPerBeat: number;
}

/**
 * Jamcorder files can declare their first global tempo late in the track
 * rather than at tick 0, which leaves the opening stretch of the file being
 * timed at the spec default of 120 BPM instead of the rate it was recorded
 * at. Every consumer then reads those notes at the wrong offset.
 *
 * When we see the Jamcorder-style "1ms per tick" pattern, mirror that first
 * tempo at tick 0. The JMX time model is 458 ticks per quarter note with a
 * Set Tempo of 458,000 microseconds per quarter note -- exactly 1,000
 * microseconds per tick. The check generalises the ratio rather than
 * hard-coding 458.
 * See https://www.jamcorder.com/docs/jmx-midi-files
 */
function shouldMirrorFirstTempoAtZero(
  ordered: Array<{ tick: number; microsecondsPerBeat: number }>,
  ticksPerBeat: number
): boolean {
  if (ordered.length === 0 || ordered[0].tick === 0) return false;

  const first = ordered[0].microsecondsPerBeat;
  const allMatch = ordered.every(
    (change) => Math.abs(change.microsecondsPerBeat - first) <= TEMPO_MATCH_EPSILON
  );
  if (!allMatch) return false;

  return Math.abs(first - ticksPerBeat * 1000) <= TEMPO_MATCH_EPSILON;
}

/** Absolute-tick Set Tempo events from every track, in tick order. */
function collectTempoChanges(tracks: MidiEvent[][]): Array<{ tick: number; microsecondsPerBeat: number }> {
  const collected: Array<{ tick: number; microsecondsPerBeat: number }> = [];

  for (const track of tracks) {
    let tick = 0;
    for (const event of track) {
      tick += event.deltaTime ?? 0;
      if (event.type !== 'setTempo') continue;

      const mpb = Number(event.microsecondsPerBeat);
      if (!Number.isFinite(mpb) || mpb <= 0) continue;

      collected.push({ tick, microsecondsPerBeat: mpb });
    }
  }

  return collected.sort((a, b) => a.tick - b.tick);
}

export function buildTempoMap(midi: MidiData): TempoMap {
  const header = midi.header;

  // SMPTE division: the frame rate fixes the tick length outright.
  if (header.framesPerSecond && header.ticksPerFrame) {
    const ticksPerSecond = header.framesPerSecond * header.ticksPerFrame;
    return {
      fixedSecondsPerTick: ticksPerSecond > 0 ? 1 / ticksPerSecond : 0,
      changes: [],
      ticksPerBeat: 0
    };
  }

  const ticksPerBeat = header.ticksPerBeat && header.ticksPerBeat > 0 ? header.ticksPerBeat : 480;
  const collected = collectTempoChanges(midi.tracks ?? []);

  if (shouldMirrorFirstTempoAtZero(collected, ticksPerBeat)) {
    collected.unshift({ tick: 0, microsecondsPerBeat: collected[0].microsecondsPerBeat });
  }
  if (collected.length === 0 || collected[0].tick !== 0) {
    collected.unshift({ tick: 0, microsecondsPerBeat: DEFAULT_MICROSECONDS_PER_BEAT });
  }

  // Walk once, accumulating elapsed seconds at each change.
  const changes: TempoChange[] = [];
  let seconds = 0;
  for (let i = 0; i < collected.length; i++) {
    const change = collected[i];
    if (i > 0) {
      const previous = changes[i - 1];
      seconds = previous.seconds
        + ((change.tick - previous.tick) * previous.microsecondsPerBeat) / (ticksPerBeat * 1e6);
    }
    changes.push({ tick: change.tick, microsecondsPerBeat: change.microsecondsPerBeat, seconds });
  }

  return { fixedSecondsPerTick: null, changes, ticksPerBeat };
}

export function ticksToSeconds(map: TempoMap, tick: number): number {
  if (map.fixedSecondsPerTick !== null) {
    return tick * map.fixedSecondsPerTick;
  }

  // Last change at or before `tick`.
  let low = 0;
  let high = map.changes.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (map.changes[mid].tick <= tick) low = mid;
    else high = mid - 1;
  }

  const active = map.changes[low];
  return active.seconds
    + ((tick - active.tick) * active.microsecondsPerBeat) / (map.ticksPerBeat * 1e6);
}
