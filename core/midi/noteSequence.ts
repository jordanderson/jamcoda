import { parseMidi } from 'midi-file';
import { buildTempoMap, ticksToSeconds } from './tempoMap';

/**
 * The one MIDI decode path for the whole app.
 *
 * The browser used to decode via `@magenta/music`'s `midiToSequenceProto`
 * while the server and ML pipeline used `@tonejs/midi` directly, so the two
 * could disagree about the notes in a file. Both now come through here.
 *
 * Isomorphic: takes bytes, touches no filesystem, and is typechecked against
 * both the DOM and Node libs.
 */

/** A single sounding note. Times are seconds from the start of the file. */
export interface Note {
  pitch: number;
  /** 0-127, matching the MIDI wire range. */
  velocity: number;
  startTime: number;
  endTime: number;
}

/**
 * A damper (sustain) pedal transition, CC 64.
 *
 * The Jamcorder records these: 235 of the 236 synced files carry CC 64
 * events. The decode keeps them so playback can model the pedal -- a key's
 * release is deferred while the pedal is down -- and feature extraction and
 * duration consumers ignore them.
 */
export interface SustainPedalEvent {
  /** Seconds from the start of the file. */
  time: number;
  /** true = pedal pressed (value >= 64), false = pedal released. */
  on: boolean;
  /** Raw CC64 value, 0-127. */
  value: number;
}

export interface NoteSequence {
  notes: Note[];
  /** End of the last sounding note, in seconds. */
  totalTime: number;
  /** Damper pedal (CC 64) transitions, time-ordered. Empty when none. */
  sustainEvents: SustainPedalEvent[];
}

/** All Sound Off and All Notes Off. Both silence everything on their channel. */
const CC_ALL_SOUND_OFF = 120;
const CC_ALL_NOTES_OFF = 123;

/** Damper (sustain) pedal. Values >= 64 hold the pedal down. */
const CC_DAMPER = 64;

/**
 * Longest note we will credit to an All Notes Off, in seconds.
 *
 * A Note Off is a measured release. An All Notes Off is the device saying it
 * does not know when the keys came up -- it fires when the Jamcorder goes
 * idle -- so the gap back to the Note On is an upper bound, not a duration.
 * Across the library 337 of the 342 notes that end this way are under ten
 * seconds (median 39ms: the last keys struck before the device went quiet).
 * The tail is not playing. One stray Note On -- pitch 127, the only one in
 * two million notes, above the top of an 88-key piano -- sat open for 24
 * minutes before an All Notes Off collected it.
 *
 * Capping only these leaves every measured release untouched.
 */
const MAX_ALL_NOTES_OFF_SECONDS = 30;

interface OpenNote {
  tick: number;
  velocity: number;
}

/**
 * Decode Standard MIDI File bytes into a flat, time-ordered note list.
 *
 * Tracks are flattened. Jamcorder captures a single performance, and every
 * consumer (playback, piano roll, feature extraction) wants one stream.
 *
 * Notes are paired here rather than by a library because the Jamcorder ends
 * sounding notes with All Notes Off (CC 123) before it goes idle, instead of
 * sending a Note Off for each. `@tonejs/midi`, which we decoded with before,
 * pairs only Note On to Note Off and ignores channel mode messages -- so an
 * All Notes Off left its notes open, and its strict "oldest Note On takes the
 * next Note Off for that pitch" rule then handed each of them the release
 * belonging to the *following* press. A single All Notes Off therefore
 * shifted every later note of that pitch for the rest of the file, inventing
 * sustains of twenty minutes and more. Across the library that was 517 notes
 * over a minute long: 22.7 note-hours that were never played.
 */
export function parseNoteSequence(rawBytes: Uint8Array): NoteSequence {
  let midi;
  try {
    midi = parseMidi(rawBytes);
  } catch {
    return { notes: [], totalTime: 0, sustainEvents: [] };
  }

  const tempoMap = buildTempoMap(midi);
  const notes: Note[] = [];
  const sustainEvents: SustainPedalEvent[] = [];
  let totalTime = 0;

  const addNote = (
    pitch: number,
    velocity: number,
    startTick: number,
    endTick: number,
    endedByAllNotesOff = false
  ): void => {
    const startTime = ticksToSeconds(tempoMap, startTick);
    let endTime = ticksToSeconds(tempoMap, endTick);

    if (endedByAllNotesOff) {
      endTime = Math.min(endTime, startTime + MAX_ALL_NOTES_OFF_SECONDS);
    }

    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
      return;
    }

    notes.push({
      pitch,
      velocity: Math.max(0, Math.min(127, Math.round(velocity))),
      startTime,
      endTime
    });

    if (endTime > totalTime) totalTime = endTime;
  };

  for (const track of midi.tracks ?? []) {
    // Keyed by channel * 128 + pitch. A held note is only released by an event
    // on its own channel, and one pitch can sound on two channels at once.
    const open = new Map<number, OpenNote[]>();
    let tick = 0;

    for (const event of track) {
      tick += event.deltaTime ?? 0;

      if (event.type === 'noteOn' && event.velocity > 0) {
        const key = event.channel * 128 + event.noteNumber;
        const pending = open.get(key);
        if (pending) pending.push({ tick, velocity: event.velocity });
        else open.set(key, [{ tick, velocity: event.velocity }]);
        continue;
      }

      // A Note On of velocity 0 is a Note Off; the wire format allows both.
      if (event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)) {
        // Oldest first, so a pitch struck twice before either release reads as
        // the first press ending at the first release.
        const note = open.get(event.channel * 128 + event.noteNumber)?.shift();
        if (note) addNote(event.noteNumber, note.velocity, note.tick, tick);
        continue;
      }

      if (
        event.type === 'controller'
        && (event.controllerType === CC_ALL_NOTES_OFF || event.controllerType === CC_ALL_SOUND_OFF)
      ) {
        for (const [key, pending] of open) {
          if (Math.floor(key / 128) !== event.channel) continue;
          for (const note of pending) addNote(key % 128, note.velocity, note.tick, tick, true);
          pending.length = 0;
        }
        continue;
      }

      if (event.type === 'controller' && event.controllerType === CC_DAMPER) {
        sustainEvents.push({
          time: ticksToSeconds(tempoMap, tick),
          on: event.value >= 64,
          value: event.value
        });
      }
    }

    // Anything still sounding at the end of the track was never released by
    // anything: no Note Off, no All Notes Off. There is no honest end time for
    // it, and the previous decoder dropped these too, so leave them out rather
    // than invent a duration running to the end of the recording.
  }

  notes.sort((a, b) => (a.startTime - b.startTime) || (a.pitch - b.pitch));
  sustainEvents.sort((a, b) => a.time - b.time);

  return { notes, totalTime, sustainEvents };
}

/** Lowest and highest pitch present, or null for an empty sequence. */
export function pitchRange(notes: Note[]): { minPitch: number; maxPitch: number } | null {
  if (notes.length === 0) return null;

  let minPitch = notes[0].pitch;
  let maxPitch = notes[0].pitch;
  for (const note of notes) {
    if (note.pitch < minPitch) minPitch = note.pitch;
    if (note.pitch > maxPitch) maxPitch = note.pitch;
  }
  return { minPitch, maxPitch };
}

/** A span where the damper pedal was held down. */
export interface PedalInterval {
  down: number;
  /** When the pedal lifted; null when it was still down at the end of the file. */
  up: number | null;
}

/**
 * Reduce CC 64 sustain events into down/up spans. Consecutive presses extend
 * one span; a release with no span open, or a zero-length press, is dropped.
 */
export function buildPedalIntervals(events: SustainPedalEvent[]): PedalInterval[] {
  const intervals: PedalInterval[] = [];
  let open: PedalInterval | null = null;

  for (const event of events) {
    if (event.on) {
      if (!open) open = { down: event.time, up: null };
    } else if (open) {
      if (event.time > open.down) {
        open.up = event.time;
        intervals.push(open);
        open = null;
      } else {
        open = null;
      }
    }
  }

  if (open) intervals.push(open);
  return intervals;
}

/**
 * The pedal span holding a note released at `endTime`, or null when the pedal
 * was up (the key's own release stands). A key lifted on the same instant the
 * pedal lifts is not sustained: the damper has already fallen.
 */
export function heldByPedal(intervals: PedalInterval[], endTime: number): PedalInterval | null {
  for (const interval of intervals) {
    if (interval.down > endTime) break;
    if (interval.up === null || endTime < interval.up) return interval;
  }
  return null;
}

/**
 * Pedal state just before `time`: whether the most recent CC 64 event at or
 * before `time` is a press.
 */
function pedalDownBefore(sustainEvents: SustainPedalEvent[], time: number): boolean {
  let down = false;
  for (const event of sustainEvents) {
    if (event.time > time) break;
    down = event.on;
  }
  return down;
}

/**
 * Sustain events re-based into `[start, end)`.
 *
 * A window that starts while the pedal is already down gets a synthetic press
 * at its own start, so a note released before the first in-window release
 * still reads as sustained. Without that seed, segment playback would silently
 * drop a pedal that was held across the boundary.
 */
function sliceSustainEvents(
  sustainEvents: SustainPedalEvent[],
  start: number,
  end: number
): SustainPedalEvent[] {
  const clipped: SustainPedalEvent[] = [];
  for (const event of sustainEvents) {
    if (event.time < start) continue;
    if (event.time >= end) break;
    clipped.push({ ...event, time: event.time - start });
  }

  const startsAtPress = clipped[0]?.time === 0 && clipped[0].on;
  if (pedalDownBefore(sustainEvents, start) && !startsAtPress) {
    clipped.unshift({ time: 0, on: true, value: 127 });
  }
  return clipped;
}

/**
 * Notes overlapping `[startTime, endTime)`, re-based so the window starts at
 * zero and clipped to its length. Used for segment playback.
 */
export function sliceSequence(
  sequence: NoteSequence,
  startTime: number,
  endTime: number
): NoteSequence {
  const duration = endTime - startTime;

  const notes = sequence.notes
    .filter((note) => note.endTime > startTime && note.startTime < endTime)
    .map((note) => ({
      ...note,
      startTime: Math.max(0, note.startTime - startTime),
      endTime: Math.min(duration, note.endTime - startTime)
    }))
    .filter((note) => note.endTime > 0);

  return { notes, totalTime: duration, sustainEvents: sliceSustainEvents(sequence.sustainEvents, startTime, endTime) };
}

/** Notes from `startTime` onward, re-based to zero. Used for seeking. */
export function sequenceFrom(sequence: NoteSequence, startTime: number): NoteSequence {
  if (startTime <= 0) return sequence;
  return sliceSequence(sequence, startTime, sequence.totalTime);
}
