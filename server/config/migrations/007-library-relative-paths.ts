import { existsSync } from 'node:fs';
import path from 'node:path';
import { libraryRelativeFromLegacy, MIDI_SUBDIR, resolveStoredMidiPath } from '../library';
import type { Migration } from './types';

/** The `midi` folder an absolute legacy path names: everything through its last `/midi/`. */
function legacyMidiDir(localPath: string): string {
  const normalized = localPath.replace(/\\/g, '/');
  return normalized.slice(0, normalized.lastIndexOf(`/${MIDI_SUBDIR}/`) + MIDI_SUBDIR.length + 1);
}

/**
 * Stores `files.local_path` relative to the library folder (see
 * `server/config/library.ts`). A path already in the library-relative form
 * keeps its value, but is checked like any other.
 *
 * Refuses, rolling back, when a path has no `midi` directory, or when a file
 * that exists at its current path would not exist at its new one — the
 * recordings then live somewhere other than `<library>/midi`, and moving that
 * folder beside the database is the fix. A file missing from both places
 * stays missing and does not block the migration, unless its path is
 * absolute and its `midi` folder cannot be found either: that is a drive
 * that is not connected, and rewriting the path would lose where the
 * recordings are.
 */
export const libraryRelativePathsMigration: Migration = {
  id: '007-library-relative-paths',
  description: 'Store MIDI paths relative to the library folder',
  up: (db, dbPath) => {
    const rows = db.prepare('SELECT id, local_path FROM files').all() as unknown as Array<{ id: number; local_path: string }>;
    const update = db.prepare('UPDATE files SET local_path = ? WHERE id = ?');
    const problems: string[] = [];
    const updates: Array<{ id: number; relative: string }> = [];

    for (const row of rows) {
      const relative = libraryRelativeFromLegacy(row.local_path);
      if (!relative) {
        problems.push(`${row.local_path} (no midi folder in the path)`);
        continue;
      }
      const before = path.resolve(row.local_path);
      const after = resolveStoredMidiPath(relative, dbPath);
      if (!existsSync(after)) {
        if (existsSync(before)) {
          problems.push(`${row.local_path} (expected at ${after})`);
          continue;
        }
        if (path.isAbsolute(row.local_path) && !existsSync(legacyMidiDir(row.local_path))) {
          problems.push(`${row.local_path} (the folder ${legacyMidiDir(row.local_path)} cannot be found; connect the drive it is on)`);
          continue;
        }
      }
      if (relative !== row.local_path) updates.push({ id: row.id, relative });
    }

    if (problems.length > 0) {
      const shown = problems.slice(0, 5).map((problem) => `  ${problem}`).join('\n');
      const more = problems.length > 5 ? `\n  …and ${problems.length - 5} more` : '';
      throw new Error(
        `Cannot store MIDI paths relative to ${path.dirname(dbPath)}: the recordings must be in its midi folder, `
          + `and any drive they are on must be connected.\n${shown}${more}`
      );
    }
    for (const { id, relative } of updates) update.run(relative, id);
  }
};
