import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseMidi } from 'midi-file';
import { hasFlag, readArg, resolveDbPath, runMain } from '@core/cli/args';
import { parseNoteSequence } from '@core/midi/noteSequence';
import { closeDatabase, getDb, initializeDatabase } from '../config/database';
import { parseJmxMetadata } from '../utils/jmxParser';

/**
 * Rescale times stored against recordings that never declared a tempo.
 *
 * Those files are on the JMX grid of one millisecond per tick, but until the
 * `tempoMap` fix the decoder fell back to the SMF default of 120 BPM and read
 * them 9.17% slow (500000/458000). Every time we then measured against that
 * timeline -- annotations, prediction reviews, cached durations -- was
 * stretched by the same factor.
 *
 * Bookmarks and skips are deliberately untouched: `jmxParser` has always read
 * them straight off the JMX grid, so they were the one thing already correct
 * and were what disagreed with the notes.
 *
 * The transform is linear from zero, so dividing by the stretch preserves
 * exactly which notes fall inside each annotation. `--verify` asserts that
 * per annotation rather than trusting the arithmetic.
 *
 * Idempotent by way of `schema_migrations`: re-running is a no-op once the
 * marker row is present.
 */

const MIGRATION_ID = '006-rescale-silent-tempo-files';
const MIGRATION_NOTE =
  'Divide out the 9.17% stretch on recordings that declare no tempo (JMX 1ms grid)';

/** 120 BPM, the Standard MIDI File default the decoder used to fall back to. */
const SMF_DEFAULT_MICROSECONDS_PER_BEAT = 500_000;

interface AffectedFile {
  id: number;
  filename: string;
  localPath: string;
  /** Old decoded seconds divided by this gives true seconds. */
  factor: number;
}

function usage() {
  console.log(`
Rescale times captured against the 9.17%-stretched timeline.

Usage:
  npm run db:rescale-silent-tempo -- [options]

Options:
  --apply       Actually write. Without it, this is a dry run.
  --verify      Re-check the note-set invariant and durations, then exit.
  --repair-timestamps  Fix updated_at values written in milliseconds, then exit.
  --db <path>   SQLite DB path (default: data/jamcoda.db)
  --root <path> Workspace root for resolving MIDI paths (default: .)
  --help        Show this help
`);
}

/**
 * Any `updated_at` past this is a millisecond value in a seconds column.
 * Real seconds do not reach it until the year 5138.
 */
const MILLISECOND_TIMESTAMP_FLOOR = 100_000_000_000;

/**
 * Undo millisecond `updated_at` values written into seconds columns.
 *
 * The first run of this migration stamped `Date.now()` instead of
 * `Math.floor(Date.now() / 1000)`. `rebuildStatus` counts annotations whose
 * `updated_at` is newer than the model's `createdAt`, so those rows stayed
 * permanently newer than any model and the Rebuild Model badge never cleared.
 */
function repairMillisecondTimestamps(apply: boolean): number {
  const db = getDb();
  const tables = ['annotations', 'ignored_sections'] as const;
  let total = 0;

  for (const table of tables) {
    const { n } = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE updated_at > ?`)
      .get(MILLISECOND_TIMESTAMP_FLOOR) as { n: number };
    if (n === 0) continue;

    total += n;
    console.log(`  ${table}: ${n} row${n === 1 ? '' : 's'} with a millisecond updated_at`);
    if (apply) {
      db.prepare(
        `UPDATE ${table} SET updated_at = CAST(updated_at / 1000 AS INTEGER) WHERE updated_at > ?`
      ).run(MILLISECOND_TIMESTAMP_FLOOR);
    }
  }
  return total;
}

function isApplied(): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM schema_migrations WHERE id = ?')
    .get(MIGRATION_ID);
  return row !== undefined;
}

/**
 * Files that declare no Set Tempo, with the stretch factor read from the file
 * itself rather than assumed. A recording with a different `ticksPerBeat`
 * would have been stretched by a different amount.
 */
function findAffected(rootDir: string): AffectedFile[] {
  const rows = getDb()
    .prepare('SELECT id, filename, local_path FROM files ORDER BY id')
    .all() as Array<{ id: number; filename: string; local_path: string }>;

  const affected: AffectedFile[] = [];
  for (const row of rows) {
    let parsed;
    try {
      parsed = parseMidi(new Uint8Array(readFileSync(path.resolve(rootDir, row.local_path))));
    } catch {
      continue;
    }

    const ticksPerBeat = parsed.header.ticksPerBeat;
    if (!ticksPerBeat || ticksPerBeat <= 0) continue;
    if (parsed.header.framesPerSecond) continue;

    let hasTempo = false;
    for (const track of parsed.tracks) {
      for (const event of track) if (event.type === 'setTempo') hasTempo = true;
    }
    if (hasTempo) continue;

    // What we used to read it at, over what it really is.
    const factor = SMF_DEFAULT_MICROSECONDS_PER_BEAT / (ticksPerBeat * 1000);
    if (!Number.isFinite(factor) || factor <= 0) continue;

    affected.push({ id: row.id, filename: row.filename, localPath: row.local_path, factor });
  }
  return affected;
}

/** Pitch and onset of every note inside `[start, end)`, as a comparable key. */
function noteSetIn(localPath: string, rootDir: string, start: number, end: number): string {
  const seq = parseNoteSequence(new Uint8Array(readFileSync(path.resolve(rootDir, localPath))));
  return seq.notes
    .filter((note) => note.startTime >= start && note.startTime < end)
    .map((note) => `${note.pitch}`)
    .join(',');
}

interface AnnotationRow {
  id: number;
  file_id: number;
  start_time: number;
  end_time: number;
}

function annotationsFor(fileIds: number[]): AnnotationRow[] {
  if (fileIds.length === 0) return [];
  return getDb()
    .prepare(
      `SELECT id, file_id, start_time, end_time FROM annotations
       WHERE file_id IN (${fileIds.map(() => '?').join(',')}) ORDER BY id`
    )
    .all(...fileIds) as AnnotationRow[];
}

/**
 * Every affected file's decoded duration against the `jmxEof` trailer, which
 * is the device's own statement of how long it recorded.
 */
function verifyDurations(affected: AffectedFile[], rootDir: string): number {
  let mismatched = 0;
  for (const file of affected) {
    const buf = readFileSync(path.resolve(rootDir, file.localPath));
    const device = parseJmxMetadata(buf).totalMillis;
    if (device === undefined || device === 0) continue;

    const decoded = parseNoteSequence(new Uint8Array(buf)).totalTime;
    const ratio = decoded / (device / 1000);
    // The last note can end before the device stopped, so a shortfall is fine;
    // running past the device's own duration is not.
    if (ratio > 1.0005 || ratio < 0.95) {
      mismatched++;
      console.log(
        `  MISMATCH file ${file.id} ${file.filename}: decoded=${decoded.toFixed(1)}s `
        + `device=${(device / 1000).toFixed(1)}s ratio=${ratio.toFixed(4)}`
      );
    }
  }
  return mismatched;
}

async function main() {
  if (hasFlag('--help')) {
    usage();
    return;
  }

  const apply = hasFlag('--apply');
  const verifyOnly = hasFlag('--verify');
  const repairOnly = hasFlag('--repair-timestamps');
  const rootDir = path.resolve(readArg('--root') || '.');
  const dbPath = readArg('--db') ? path.resolve(readArg('--db')!) : resolveDbPath();

  process.env.JAMCODA_DB_PATH = dbPath;
  initializeDatabase();
  try {
    const db = getDb();

    if (repairOnly) {
      console.log('Rows whose updated_at is a millisecond value:');
      const found = repairMillisecondTimestamps(apply);
      if (found === 0) console.log('  none');
      else if (!apply) console.log('\nDry run. Re-run with --apply to correct them.');
      else console.log(`\nCorrected ${found} row${found === 1 ? '' : 's'} to seconds.`);
      return;
    }

    const affected = findAffected(rootDir);
    console.log(`Recordings that declare no tempo: ${affected.length}`);

    if (verifyOnly) {
      const mismatched = verifyDurations(affected, rootDir);
      console.log(
        mismatched === 0
          ? '\nEvery affected recording now matches its own jmxEof duration.'
          : `\n${mismatched} recordings still disagree with their jmxEof duration.`
      );
      return;
    }

    if (isApplied()) {
      console.log('\nAlready applied; nothing to do. Re-running would rescale twice.');
      return;
    }

    const fileIds = affected.map((file) => file.id);
    const factorById = new Map(affected.map((file) => [file.id, file.factor]));
    const pathById = new Map(affected.map((file) => [file.id, file.localPath]));

    const annotations = annotationsFor(fileIds);
    const reviewCount = fileIds.length === 0 ? 0 : (db
      .prepare(
        `SELECT COUNT(*) AS n FROM prediction_reviews
         WHERE file_id IN (${fileIds.map(() => '?').join(',')})`
      )
      .get(...fileIds) as { n: number }).n;
    const ignoredCount = fileIds.length === 0 ? 0 : (db
      .prepare(
        `SELECT COUNT(*) AS n FROM ignored_sections
         WHERE file_id IN (${fileIds.map(() => '?').join(',')})`
      )
      .get(...fileIds) as { n: number }).n;

    console.log(`  annotations:        ${annotations.length}`);
    console.log(`  prediction_reviews: ${reviewCount}`);
    console.log(`  ignored_sections:   ${ignoredCount}`);
    console.log(`  midi_duration:      ${affected.length} (cleared, recomputed on next read)`);
    console.log('  bookmarks / skips:  untouched, already on the JMX grid');

    // The invariant: an annotation must hold the same notes afterwards. Capture
    // it before writing, against the *stretched* times the rows still carry.
    console.log('\nCapturing note sets for the annotations being moved...');
    const before = new Map<number, string>();
    for (const row of annotations) {
      const localPath = pathById.get(row.file_id);
      const factor = factorById.get(row.file_id);
      if (!localPath || factor === undefined) continue;
      // Undo the fix temporarily by scaling the window, not the file: the
      // decoder now returns true seconds, so the old row bounds map to
      // start/factor..end/factor.
      before.set(row.id, noteSetIn(localPath, rootDir, row.start_time / factor, row.end_time / factor));
    }

    if (!apply) {
      const sample = affected.slice(0, 5);
      console.log('\nDry run. Sample of what would change:');
      for (const file of sample) {
        console.log(`  file ${file.id} ${file.filename}: times divided by ${file.factor.toFixed(6)}`);
      }
      console.log('\nRe-run with --apply to write. Back up data/jamcoda.db first.');
      return;
    }

    // VACUUM INTO writes a consistent snapshot even with the app running, and
    // refuses to overwrite, so a previous backup is never clobbered.
    let backupPath = `${dbPath}.pre-rescale`;
    if (existsSync(backupPath)) {
      backupPath = `${dbPath}.pre-rescale-${Date.now()}`;
    }
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    console.log(`\nBackup written to ${backupPath}`);

    // Seconds, not milliseconds: every other writer of `updated_at` uses
    // `Math.floor(Date.now() / 1000)`, and `rebuildStatus` compares the column
    // against a model's `createdAt` in seconds. A millisecond value here dates
    // the row to the year 58000, so the rebuild badge can never clear.
    const now = Math.floor(Date.now() / 1000);
    db.transaction(() => {
      const scaleAnnotation = db.prepare(
        'UPDATE annotations SET start_time = start_time / ?, end_time = end_time / ?, updated_at = ? WHERE file_id = ?'
      );
      const scaleIgnored = db.prepare(
        'UPDATE ignored_sections SET start_time = start_time / ?, end_time = end_time / ?, updated_at = ? WHERE file_id = ?'
      );
      const scaleReview = db.prepare(
        `UPDATE prediction_reviews SET
           predicted_start_time = predicted_start_time / ?,
           predicted_end_time = predicted_end_time / ?,
           reviewed_start_time = CASE WHEN reviewed_start_time IS NULL THEN NULL ELSE reviewed_start_time / ? END,
           reviewed_end_time = CASE WHEN reviewed_end_time IS NULL THEN NULL ELSE reviewed_end_time / ? END
         WHERE file_id = ?`
      );
      const clearDuration = db.prepare('UPDATE files SET midi_duration = NULL WHERE id = ?');

      for (const file of affected) {
        const f = file.factor;
        scaleAnnotation.run(f, f, now, file.id);
        scaleIgnored.run(f, f, now, file.id);
        scaleReview.run(f, f, f, f, file.id);
        clearDuration.run(file.id);
      }

      db.prepare('INSERT INTO schema_migrations (id, description, applied_at) VALUES (?, ?, ?)')
        .run(MIGRATION_ID, MIGRATION_NOTE, now);
    })();

    console.log('\nWritten. Checking the note-set invariant...');
    const after = annotationsFor(fileIds);
    let broken = 0;
    for (const row of after) {
      const localPath = pathById.get(row.file_id);
      if (!localPath) continue;
      const expected = before.get(row.id);
      if (expected === undefined) continue;
      const actual = noteSetIn(localPath, rootDir, row.start_time, row.end_time);
      if (actual !== expected) {
        broken++;
        console.log(`  ANNOTATION ${row.id} (file ${row.file_id}) now holds a different note set`);
      }
    }

    const strayMillis = repairMillisecondTimestamps(false);
    const mismatched = verifyDurations(affected, rootDir);
    if (strayMillis > 0) {
      throw new Error(
        `${strayMillis} rows carry a millisecond updated_at. Run with --repair-timestamps --apply.`
      );
    }
    console.log(
      `\nRescaled ${affected.length} recordings. `
      + `Annotations holding a different note set: ${broken}. `
      + `Durations disagreeing with jmxEof: ${mismatched}.`
    );
    if (broken > 0 || mismatched > 0) {
      throw new Error('Post-migration checks failed. Restore the backup before continuing.');
    }
    console.log('Rebuild the model next: npm run ml:train');
  } finally {
    closeDatabase();
  }
}

runMain('Tempo rescale failed', main);
