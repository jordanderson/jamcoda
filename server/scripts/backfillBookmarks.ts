import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { hasFlag, readArg, resolveDbPath, runMain } from '@core/cli/args';
import { closeDatabase, getDb, initializeDatabase } from '../config/database';
import { parseJmxMetadata } from '../utils/jmxParser';
import type { JmxBookmark, JmxSkip } from '../types';

/**
 * Backfill `files.bookmarks_json` and `files.skips_json` for files synced
 * before JMX boundary parsing existed. Sync now records both on every
 * new/re-synced file; this is a one-time pass over the already-synced library
 * so passage markers and silence gaps on older recordings surface without a
 * device re-sync. Safe to re-run.
 */

interface FileRow {
  id: number;
  localPath: string;
}

function usage() {
  console.log(`
Backfill passage bookmarks and silence gaps for already-synced files.

Usage:
  npm run db:backfill-bookmarks -- [options]

Options:
  --db <path>   SQLite DB path (default: data/jamcoda.db)
  --help        Show this help
`);
}

function serializeList<T>(items: T[] | undefined): string | null {
  return items && items.length > 0 ? JSON.stringify(items) : null;
}

async function main() {
  if (hasFlag('--help')) {
    usage();
    return;
  }

  const dbPath = readArg('--db') ? path.resolve(readArg('--db')!) : resolveDbPath();
  process.env.JAMCODA_DB_PATH = dbPath;
  initializeDatabase();

  try {
    const rows = getDb().prepare(
      'SELECT id, local_path as localPath FROM files'
    ).all() as FileRow[];

    const update = getDb().prepare('UPDATE files SET bookmarks_json = ?, skips_json = ? WHERE id = ?');
    let updated = 0;
    let withBookmarks = 0;
    let withSkips = 0;

    for (const row of rows) {
      if (!existsSync(row.localPath)) continue;
      const jmx = parseJmxMetadata(readFileSync(row.localPath));
      const bookmarksJson = serializeList<JmxBookmark>(jmx.bookmarks);
      const skipsJson = serializeList<JmxSkip>(jmx.skips);
      if (bookmarksJson === null && skipsJson === null) continue;
      update.run(bookmarksJson, skipsJson, row.id);
      updated++;
      if (bookmarksJson !== null) withBookmarks++;
      if (skipsJson !== null) withSkips++;
    }

    console.log(`Database: ${dbPath}`);
    console.log(`Scanned ${rows.length} file(s); stored boundary metadata for ${updated} `
      + `(${withBookmarks} with bookmarks, ${withSkips} with silence gaps).`);
  } finally {
    closeDatabase();
  }
}

runMain('Backfill failed', main);