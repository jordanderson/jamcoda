import { parseMidi, writeMidi } from 'midi-file';

type MidiLikeEvent = {
  deltaTime?: number;
  type?: string;
  microsecondsPerBeat?: number;
};

type ParsedMidiLike = {
  header?: {
    ticksPerBeat?: number;
  };
  tracks?: MidiLikeEvent[][];
};

const TEMPO_MATCH_EPSILON = 1;

/**
 * Jamcorder files can include their first global tempo event late in the
 * track (not at tick 0). Some parsers then build a non-monotonic second map,
 * causing two tick regions to collapse into the same displayed time range.
 *
 * When we detect the Jamcorder-style "1ms per tick" tempo event pattern, we
 * mirror that first tempo at tick 0 to keep time mapping monotonic.
 *
 * The "1ms per tick" pattern is the JMX time model: 458 ticks per quarter
 * note with a Set Tempo of 458,000 microseconds per quarter note, i.e.
 * exactly 1,000 microseconds per tick. The check below is `ticksPerBeat * 1000`
 * to generalize the ratio rather than hard-code 458.
 * See https://www.jamcorder.com/docs/jmx-midi-files
 */
export function normalizeJamcorderTempoMap(rawBytes: Uint8Array): Uint8Array {
  let parsed: ParsedMidiLike;
  try {
    parsed = parseMidi(rawBytes) as ParsedMidiLike;
  } catch {
    return rawBytes;
  }

  const ticksPerBeat = parsed.header?.ticksPerBeat;
  const tracks = parsed.tracks;
  if (!ticksPerBeat || !tracks?.length) {
    return rawBytes;
  }

  const expectedMpbForOneMsTick = ticksPerBeat * 1000;
  let mutated = false;

  for (const track of tracks) {
    let absoluteTick = 0;
    let hasTempoAtZero = false;
    let firstTempoTick: number | null = null;
    let firstTempoMpb: number | null = null;
    let allTempoValuesMatch = true;

    for (const event of track) {
      absoluteTick += event.deltaTime ?? 0;
      if (event.type !== 'setTempo' || !Number.isFinite(event.microsecondsPerBeat)) {
        continue;
      }

      const mpb = Number(event.microsecondsPerBeat);
      if (firstTempoMpb === null) {
        firstTempoMpb = mpb;
      } else if (Math.abs(firstTempoMpb - mpb) > TEMPO_MATCH_EPSILON) {
        allTempoValuesMatch = false;
      }

      if (absoluteTick === 0) {
        hasTempoAtZero = true;
        break;
      }

      if (firstTempoTick === null) {
        firstTempoTick = absoluteTick;
      }
    }

    if (
      hasTempoAtZero
      || firstTempoTick === null
      || firstTempoMpb === null
      || !allTempoValuesMatch
    ) {
      continue;
    }

    const matchesOneMsTickGrid = (
      Math.abs(firstTempoMpb - expectedMpbForOneMsTick) <= TEMPO_MATCH_EPSILON
    );
    if (!matchesOneMsTickGrid) {
      continue;
    }

    track.unshift({
      deltaTime: 0,
      type: 'setTempo',
      microsecondsPerBeat: firstTempoMpb
    });
    mutated = true;
  }

  if (!mutated) {
    return rawBytes;
  }

  return new Uint8Array(writeMidi(parsed as any));
}
