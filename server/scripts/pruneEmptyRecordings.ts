import { existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { hasFlag, readArg, resolveDbPath, runMain } from '@core/cli/args';
import { closeDatabase, getDb, initializeDatabase } from '../config/database';
import { parseJmxMetadata } from '../utils/jmxParser';

/**
 * Remove already-synced empty recordings — assets the Jamcorder opened and
 * closed without recording a note. Sync no longer imports these, but
 * libraries synced before that change carry hundreds of them (118 on
 * 2026-02-19, 147 on 2026-04-11 on the observed device).
 *
 * Deleting is safe: the device keeps its own copy, re-syncing will not
 * bring them back, and there is no annotation work to lose. The script
 * refuses to touch rows with annotations attached and confirms each file
 * is empty by reading its JMX trailer before unlinking.
 */

interface Candidate {
  id: number;
  filename: string;
  localPath: string;
  dateRecorded: string;
  fileSize: number;
}

function usage() {
  console.log(`
Delete synced recordings that contain no notes.

Usage:
  npm run db:prune-empty -- [options]

Options:
  --apply       Actually delete. Without it, this is a dry run.
  --db <path>   SQLite DB path (default: data/jamcoda.db)
  --help        Show this help
`);
}

/**
 * A row qualifies only if its stored duration is exactly 0. NULL means "not
 * parsed yet", which is not the same thing and is left alone.
 */
function findCandidates(): Candidate[] {
  return getDb().prepare(`
    SELECT id, filename, local_path as localPath, date_recorded as dateRecorded,
           file_size as fileSize
    FROM files
    WHERE midi_duration = 0
    ORDER BY date_recorded, filename
  `).all() as Candidate[];
}

/** Rows with annotation work attached are never pruned, whatever their duration. */
function findProtectedIds(): Set<number> {
  const rows = getDb().prepare(`
    SELECT DISTINCT file_id as fileId FROM annotations
    UNION SELECT DISTINCT file_id FROM prediction_reviews
    UNION SELECT DISTINCT file_id FROM ignored_sections
  `).all() as Array<{ fileId: number }>;
  return new Set(rows.map((row) => row.fileId));
}

/**
 * Confirm a file on disk holds no music, using the device's own EOF trailer.
 * A file we cannot read or cannot parse is reported and kept. The stored
 * duration alone is not enough to justify deleting bytes.
 */
function verifyEmptyOnDisk(localPath: string): { empty: boolean; reason: string } {
  if (!existsSync(localPath)) {
    return { empty: true, reason: 'already gone from disk' };
  }
  let jmx;
  try {
    jmx = parseJmxMetadata(readFileSync(localPath));
  } catch (error) {
    return { empty: false, reason: `unreadable (${error instanceof Error ? error.message : 'unknown'})` };
  }
  if (jmx.totalNotes === 0 && jmx.totalMillis === 0) {
    return { empty: true, reason: 'JMX trailer reports 0 notes' };
  }
  if (jmx.totalNotes === undefined) {
    return { empty: false, reason: 'no JMX trailer to confirm emptiness' };
  }
  return { empty: false, reason: `JMX trailer reports ${jmx.totalNotes} notes` };
}

/** Drop a date directory once its last file is gone, so `data/midi` stays tidy. */
function removeDirIfEmpty(dir: string): boolean {
  try {
    if (!existsSync(dir)) return false;
    if (readdirSync(dir).length > 0) return false;
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
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
    const candidates = findCandidates();
    const protectedIds = findProtectedIds();

    const deletable: Candidate[] = [];
    const kept: Array<{ candidate: Candidate; reason: string }> = [];

    for (const candidate of candidates) {
      if (protectedIds.has(candidate.id)) {
        kept.push({ candidate, reason: 'has annotations, predictions or ignored sections' });
        continue;
      }
      const check = verifyEmptyOnDisk(candidate.localPath);
      if (check.empty) {
        deletable.push(candidate);
      } else {
        kept.push({ candidate, reason: check.reason });
      }
    }

    const byDate = new Map<string, number>();
    for (const candidate of deletable) {
      byDate.set(candidate.dateRecorded, (byDate.get(candidate.dateRecorded) ?? 0) + 1);
    }
    const bytes = deletable.reduce((sum, candidate) => sum + (candidate.fileSize || 0), 0);

    console.log(`Database: ${dbPath}`);
    console.log(`${candidates.length} zero-duration row${candidates.length !== 1 ? 's' : ''} found; `
      + `${deletable.length} prunable, ${kept.length} kept.`);
    if (byDate.size > 0) {
      console.log('\nPrunable by date:');
      for (const [date, count] of [...byDate].sort()) {
        console.log(`  ${date}  ${String(count).padStart(4)} file${count !== 1 ? 's' : ''}`);
      }
      console.log(`  ${'total'.padEnd(10)} ${String(deletable.length).padStart(4)} files, ${(bytes / 1024).toFixed(1)} KiB`);
    }
    if (kept.length > 0) {
      console.log('\nKept:');
      for (const { candidate, reason } of kept) {
        console.log(`  ${candidate.filename} — ${reason}`);
      }
    }

    if (!apply) {
      console.log('\nDry run. Re-run with --apply to delete.');
      return;
    }
    if (deletable.length === 0) {
      console.log('\nNothing to delete.');
      return;
    }

    const db = getDb();
    const deleteRow = db.prepare('DELETE FROM files WHERE id = ?');
    const dirs = new Set<string>();
    let filesRemoved = 0;

    // Unlink first, then drop the rows in one transaction. A crash mid-run
    // leaves rows pointing at missing files, which the next run treats as
    // "already gone from disk" and finishes cleanly.
    for (const candidate of deletable) {
      if (existsSync(candidate.localPath)) {
        unlinkSync(candidate.localPath);
        filesRemoved++;
      }
      dirs.add(path.dirname(candidate.localPath));
    }

    db.transaction(() => {
      for (const candidate of deletable) {
        deleteRow.run(candidate.id);
      }
    })();

    const dirsRemoved = [...dirs].filter(removeDirIfEmpty);

    console.log(`\nDeleted ${deletable.length} row${deletable.length !== 1 ? 's' : ''} `
      + `and ${filesRemoved} file${filesRemoved !== 1 ? 's' : ''} (${(bytes / 1024).toFixed(1)} KiB).`);
    if (dirsRemoved.length > 0) {
      console.log(`Removed ${dirsRemoved.length} now-empty director${dirsRemoved.length !== 1 ? 'ies' : 'y'}.`);
    }
  } finally {
    closeDatabase();
  }
}

runMain('Prune failed', main);
