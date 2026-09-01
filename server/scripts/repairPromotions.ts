import { existsSync } from 'node:fs';
import path from 'node:path';
import { hasFlag, readArg, resolveDbPath, runMain } from '@core/cli/args';
import { resolveReviewFields } from '@core/predictionReview';
import { closeDatabase, getDb, initializeDatabase } from '../config/database';
import type { PredictionReview } from '@server/types';

/**
 * Repair prediction reviews whose promotion was silently undone.
 *
 * `prediction_reviews.promoted_annotation_id` is declared ON DELETE SET NULL.
 * Deleting the annotation a review was promoted into used to null the link
 * without clearing `promoted_at`. The common path was the same-song merge:
 * extending an annotation over a promoted one deleted the promoted row,
 * reverting its review to unpromoted. The review reappeared on the detail
 * view and a re-promote created a duplicate annotation.
 *
 * `mergeOverlappingSameSong` now re-points those reviews at the surviving
 * annotation and `remove()` clears the whole promotion, so no new rows get
 * into this state. This is a one-time pass over rows damaged before that
 * fix.
 *
 * A row is re-linked only when exactly one same-song annotation in the same
 * file fully covers its range — the signature of a merge that absorbed it.
 * Rows with no such annotation were genuine deletes: they stay unpromoted
 * and only lose the stale `promoted_at`. Safe to re-run.
 */

interface OrphanRow {
  id: number;
  fileId: number;
  filename: string;
  song: string;
  startTime: number;
  endTime: number;
}

interface CoveringRow {
  id: number;
  start_time: number;
  end_time: number;
}

function usage() {
  console.log(`
Repair reviews left half-promoted by the ON DELETE SET NULL foreign key.

Usage:
  npm run db:repair-promotions -- [options]

Options:
  --apply       Actually write. Without it, this is a dry run.
  --db <path>   SQLite DB path (default: data/jamcoda.db)
  --help        Show this help
`);
}

/**
 * Rows that claim a promotion time but point at no annotation. `promoted_at`
 * is the only surviving evidence the review was ever promoted.
 *
 * The resolved song and range come from `resolveReviewFields`, not a SQL
 * COALESCE. Only an `edited` row reads its `reviewed_*` columns, and
 * `update()` can leave those set on a row of any status. Matching on the
 * wrong range would silently relink a row to the wrong annotation.
 */
function findOrphans(): OrphanRow[] {
  const rows = getDb().prepare(`
    SELECT r.*, f.filename AS filename
    FROM prediction_reviews r
    JOIN files f ON f.id = r.file_id
    WHERE r.promoted_at IS NOT NULL
      AND r.promoted_annotation_id IS NULL
  `).all() as Array<PredictionReview & { filename: string }>;

  return rows
    .map((row) => {
      const { songName, startTime, endTime } = resolveReviewFields(row);
      return {
        id: row.id,
        fileId: row.file_id,
        filename: row.filename,
        song: songName,
        startTime,
        endTime
      };
    })
    .sort((a, b) => a.fileId - b.fileId || a.startTime - b.startTime);
}

/**
 * Same-song annotations in the same file that fully cover the review's
 * range. A merge leaves same-song annotations non-overlapping, so a genuine
 * merge victim matches exactly one; anything else is ambiguous and left
 * alone.
 */
function findCovering(row: OrphanRow): CoveringRow[] {
  return getDb().prepare(`
    SELECT id, start_time, end_time
    FROM annotations
    WHERE file_id = ?
      AND song_name = ?
      AND start_time <= ?
      AND end_time >= ?
    ORDER BY (end_time - start_time) ASC, id ASC
  `).all(row.fileId, row.song, row.startTime, row.endTime) as CoveringRow[];
}

function fmt(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

async function main() {
  if (hasFlag('--help')) {
    usage();
    return;
  }

  const apply = hasFlag('--apply');
  const dbPath = readArg('--db') ? path.resolve(readArg('--db')!) : resolveDbPath();
  process.env.JAMCODA_DB_PATH = dbPath;
  initializeDatabase();

  try {
    const orphans = findOrphans();
    if (orphans.length === 0) {
      console.log('No half-promoted reviews found. Nothing to do.');
      return;
    }

    const relink: Array<{ row: OrphanRow; annotation: CoveringRow }> = [];
    const clear: OrphanRow[] = [];
    const ambiguous: Array<{ row: OrphanRow; covering: CoveringRow[] }> = [];

    for (const row of orphans) {
      const covering = findCovering(row);
      if (covering.length === 1) {
        relink.push({ row, annotation: covering[0] });
      } else if (covering.length === 0) {
        clear.push(row);
      } else {
        ambiguous.push({ row, covering });
      }
    }

    console.log(`Found ${orphans.length} half-promoted review${orphans.length !== 1 ? 's' : ''}.\n`);

    if (relink.length > 0) {
      console.log(`Re-link to the annotation that absorbed them (${relink.length}):`);
      for (const { row, annotation } of relink) {
        console.log(
          `  review #${row.id}  ${row.filename}  "${row.song}" `
          + `${fmt(row.startTime)}-${fmt(row.endTime)} -> annotation #${annotation.id} `
          + `${fmt(annotation.start_time)}-${fmt(annotation.end_time)}`
        );
      }
      console.log('');
    }

    if (clear.length > 0) {
      console.log(`Clear stale promoted_at, leave unpromoted (${clear.length}):`);
      for (const row of clear) {
        console.log(
          `  review #${row.id}  ${row.filename}  "${row.song}" `
          + `${fmt(row.startTime)}-${fmt(row.endTime)}  (no covering annotation)`
        );
      }
      console.log('');
    }

    if (ambiguous.length > 0) {
      console.log(`Skipped, more than one covering annotation (${ambiguous.length}):`);
      for (const { row, covering } of ambiguous) {
        console.log(
          `  review #${row.id}  ${row.filename}  "${row.song}" `
          + `${fmt(row.startTime)}-${fmt(row.endTime)} -> candidates `
          + covering.map((c) => `#${c.id}`).join(', ')
        );
      }
      console.log('');
    }

    if (!apply) {
      console.log('Dry run. Re-run with --apply to write.');
      return;
    }

    const db = getDb();

    // VACUUM INTO writes a consistent snapshot even with the app running, and
    // refuses to overwrite, so a previous backup is never clobbered.
    let backupPath = `${dbPath}.bak`;
    if (existsSync(backupPath)) {
      backupPath = `${dbPath}.bak-${Date.now()}`;
    }
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    console.log(`Backup written to ${backupPath}`);

    const now = Math.floor(Date.now() / 1000);
    const relinkStmt = db.prepare(`
      UPDATE prediction_reviews
      SET promoted_annotation_id = ?, updated_at = ?
      WHERE id = ?
    `);
    const clearStmt = db.prepare(`
      UPDATE prediction_reviews
      SET promoted_at = NULL, updated_at = ?
      WHERE id = ?
    `);

    db.transaction(() => {
      for (const { row, annotation } of relink) {
        relinkStmt.run(annotation.id, now, row.id);
      }
      for (const row of clear) {
        clearStmt.run(now, row.id);
      }
    })();

    console.log(
      `\nRe-linked ${relink.length}, cleared ${clear.length}`
      + (ambiguous.length > 0 ? `, skipped ${ambiguous.length}` : '')
      + '.'
    );
  } finally {
    closeDatabase();
  }
}

runMain('Promotion repair failed', main);
