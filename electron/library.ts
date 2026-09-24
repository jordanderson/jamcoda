import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * The database file that makes a folder a library. `server/config/library.ts`
 * describes the rest of the layout.
 */
export const LIBRARY_DB_FILENAME = 'jamcoda.db';

/**
 * What a folder the user picked holds: an existing `library`, nothing yet
 * (`empty`, which becomes a new library), or `other` files, which the app
 * never adopts as a library. Hidden files such as `.DS_Store` do not count.
 */
export function classifyLibraryFolder(dir: string): 'library' | 'empty' | 'other' {
  if (existsSync(path.join(dir, LIBRARY_DB_FILENAME))) return 'library';
  const visible = readdirSync(dir).filter((name) => !name.startsWith('.'));
  return visible.length === 0 ? 'empty' : 'other';
}
