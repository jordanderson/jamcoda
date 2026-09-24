/**
 * Reading annotated recordings out of the app database, and their notes off
 * disk. The only part of segmentation that touches I/O.
 */
import { DatabaseSync } from 'node:sqlite';
import { BUSY_TIMEOUT_MS } from '@config/database';
import { resolveStoredMidiPath } from '@config/library';
import { existsSync, readFileSync } from 'node:fs';
import { buildPedalIntervals, heldByPedal, parseNoteSequence } from '@core/midi/noteSequence';
import type { AnnotatedMidiFile, NoteEvent } from './types';

interface AnnotationSqlRow {
  file_id: number;
  song_name: string;
  start_time: number;
  end_time: number;
  local_path: string;
  filename: string;
  is_complete: number;
}

function toNum(value: unknown): number {
  if (typeof value === 'number') return value;
  return Number(value);
}

/**
 * Read-only query against the app database through `node:sqlite`, so
 * training needs no `sqlite3` command-line tool.
 */
function sqliteJsonQuery<T>(dbPath: string, sql: string): T[] {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

/** MIDI paths resolve against `dbPath`'s library folder. */
export function loadAnnotatedMidiFiles(dbPath: string): AnnotatedMidiFile[] {
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const rows = sqliteJsonQuery<AnnotationSqlRow>(
    dbPath,
    `
      SELECT
        a.file_id,
        a.song_name,
        a.start_time,
        a.end_time,
        f.local_path,
        f.filename,
        f.is_complete
      FROM annotations a
      JOIN files f ON f.id = a.file_id
      ORDER BY a.file_id ASC, a.start_time ASC
    `
  );

  const byFile = new Map<number, AnnotatedMidiFile>();

  for (const row of rows) {
    const fileId = toNum(row.file_id);
    const midiPath = resolveStoredMidiPath(row.local_path, dbPath);
    if (!existsSync(midiPath)) {
      continue;
    }

    if (!byFile.has(fileId)) {
      byFile.set(fileId, {
        fileId,
        filename: row.filename,
        midiPath,
        annotations: [],
        isComplete: toNum(row.is_complete) === 1
      });
    }

    byFile.get(fileId)!.annotations.push({
      songName: row.song_name,
      startTime: toNum(row.start_time),
      endTime: toNum(row.end_time)
    });
  }

  const files = [...byFile.values()];
  files.sort((a, b) => a.fileId - b.fileId);
  return files;
}

export function extractNotesFromMidi(midiPath: string): NoteEvent[] {
  const sequence = parseNoteSequence(new Uint8Array(readFileSync(midiPath)));
  const intervals = buildPedalIntervals(sequence.sustainEvents ?? []);

  // `core` yields absolute start/end times. Notes released under a held
  // damper pedal (CC 64) ring out acoustically: strings continue vibrating
  // until the pedal lifts or natural decay ends the ring (0.7s cap, 0.6s above C5).
  return sequence.notes.map((note) => {
    let endSec = note.endTime;
    const held = heldByPedal(intervals, note.endTime);
    if (held) {
      const pitchMax = note.pitch > 72 ? 0.6 : 0.7;
      const pedalRelease = held.up !== null ? held.up : note.endTime + pitchMax;
      const naturalLimit = note.endTime + pitchMax;
      endSec = Math.min(pedalRelease, naturalLimit);
    }
    return {
      pitch: note.pitch,
      velocity: note.velocity,
      startSec: note.startTime,
      endSec: Math.max(endSec, note.endTime),
      keyEndSec: note.endTime
    };
  });
}
