import * as toneMidiPkg from '@tonejs/midi';
import { normalizeJamcorderTempoMap } from './tempoNormalization';

/**
 * `@tonejs/midi` ships as CommonJS with no `exports` map, so Node's ESM loader
 * cannot statically see its named exports: `import { Midi }` typechecks (the
 * .d.ts declares it) and works under Vite, but throws
 * "does not provide an export named 'Midi'" in the Node-run CLIs.
 *
 * Reach through whichever interop shape the loader produced. Do not simplify
 * this to a named import.
 */
const Midi = (
  (toneMidiPkg as { Midi?: typeof toneMidiPkg.Midi }).Midi
  ?? (toneMidiPkg as unknown as { default?: { Midi?: typeof toneMidiPkg.Midi } }).default?.Midi
) as typeof toneMidiPkg.Midi;

/**
 * The one MIDI decode path for the whole app.
 *
 * The browser used to decode via `@magenta/music`'s `midiToSequenceProto`
 * while the server and ML pipeline used `@tonejs/midi` directly, so the two
 * could in principle disagree about the notes in a file. Both now come through
 * here, on top of the same Jamcorder tempo-map fix.
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

export interface NoteSequence {
  notes: Note[];
  /** End of the last sounding note, in seconds. */
  totalTime: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Decode Standard MIDI File bytes into a flat, time-ordered note list.
 *
 * Tracks are flattened: Jamcorder captures a single performance, and every
 * consumer (playback, piano roll, feature extraction) wants one stream.
 */
export function parseNoteSequence(rawBytes: Uint8Array): NoteSequence {
  const normalized = normalizeJamcorderTempoMap(rawBytes);
  const midi = new Midi(normalized);

  const notes: Note[] = [];
  let totalTime = 0;

  for (const track of midi.tracks) {
    for (const note of track.notes) {
      const startTime = Number(note.time);
      const endTime = startTime + Number(note.duration);

      if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
        continue;
      }

      notes.push({
        pitch: note.midi,
        velocity: Math.round(clamp01(Number(note.velocity)) * 127),
        startTime,
        endTime
      });

      if (endTime > totalTime) {
        totalTime = endTime;
      }
    }
  }

  notes.sort((a, b) => (a.startTime - b.startTime) || (a.pitch - b.pitch));

  return { notes, totalTime };
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

  return { notes, totalTime: duration };
}

/** Notes from `startTime` onward, re-based to zero. Used for seeking. */
export function sequenceFrom(sequence: NoteSequence, startTime: number): NoteSequence {
  if (startTime <= 0) return sequence;
  return sliceSequence(sequence, startTime, sequence.totalTime);
}
