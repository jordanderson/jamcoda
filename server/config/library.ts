/**
 * A library is the folder that holds `jamcoda.db`. Everything else it owns
 * sits beside the database, so the folder can be moved, backed up or opened
 * from another app install as a unit:
 *
 * - `midi/YYYY-MM-DD/<file>.mid` — synced recordings
 * - `ml/model.json` — the song model trained from this library's annotations
 *
 * `files.local_path` is stored relative to the library folder, with forward
 * slashes, so nothing in the database names the folder it lives in.
 */
import path from 'node:path';

/** The repository's library, used when `JAMCODA_DB_PATH` is unset. */
export const APP_DB_PATH = './data/jamcoda.db';

/**
 * The database path from `JAMCODA_DB_PATH`, as given. CLIs that take `--db`
 * use `resolveDbPath` in `core/cli/args` instead.
 */
export function dbPathFromEnv(): string {
  return process.env.JAMCODA_DB_PATH || APP_DB_PATH;
}

export const MIDI_SUBDIR = 'midi';

/** The library folder for a database path; the running server's by default. */
export function libraryDir(dbPath = dbPathFromEnv()): string {
  return path.dirname(path.resolve(dbPath));
}

export function libraryMidiDir(dbPath?: string): string {
  return path.join(libraryDir(dbPath), MIDI_SUBDIR);
}

export function libraryModelPath(dbPath?: string): string {
  return path.join(libraryDir(dbPath), 'ml', 'model.json');
}

/** A stored `local_path` as an absolute path on disk. */
export function resolveStoredMidiPath(localPath: string, dbPath?: string): string {
  return path.resolve(libraryDir(dbPath), localPath);
}

/** An absolute path inside the library as it is stored in `files.local_path`. */
export function toStoredMidiPath(absolutePath: string, dbPath?: string): string {
  return path.relative(libraryDir(dbPath), absolutePath).split(path.sep).join('/');
}

/**
 * The library-relative form of a `local_path` written before paths were
 * stored relative: an absolute path (the desktop app) or one relative to the
 * repository (`data/midi/...`). Both end in `.../midi/<date>/<file>`, and the
 * last `midi` directory in the path is the library's. Returns null for a path
 * with no `midi` directory, which the caller must not guess at.
 */
export function libraryRelativeFromLegacy(localPath: string): string | null {
  const normalized = localPath.replace(/\\/g, '/');
  if (normalized.startsWith(`${MIDI_SUBDIR}/`)) return normalized;
  const marker = `/${MIDI_SUBDIR}/`;
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return null;
  const rest = normalized.slice(index + marker.length);
  return rest ? `${MIDI_SUBDIR}/${rest}` : null;
}
