import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'vitest';
import { runMigrations } from './index';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'jamcoda-007-'));
  dbPath = path.join(dir, 'jamcoda.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A database migrated up to 006, holding the given `local_path` values. */
function databaseBefore007(localPaths: string[]): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  runMigrations(db, dbPath);
  db.prepare("DELETE FROM schema_migrations WHERE id = '007-library-relative-paths'").run();
  const insert = db.prepare(`
    INSERT INTO files (jamcorder_path, local_path, filename, file_size, jamcorder_modified, synced_at, date_recorded)
    VALUES (?, ?, ?, 1, 0, 0, '2025-10-14')
  `);
  localPaths.forEach((localPath, i) => insert.run(`/JAMC/${i}.mid`, localPath, `${i}.mid`));
  return db;
}

function storedPaths(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT local_path FROM files ORDER BY id').all() as unknown as Array<{ local_path: string }>;
  return rows.map((row) => row.local_path);
}

function backupsIn(folder: string): string[] {
  return readdirSync(folder).filter((name) => name.startsWith('jamcoda.db.pre-'));
}

function writeMidi(relative: string): string {
  const file = path.join(dir, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'midi');
  return file;
}

test('absolute and repo-relative paths become library-relative', () => {
  const absolute = writeMidi('midi/2025-10-14/a.mid');
  const deleted = path.join(dir, 'midi', '2025-10-14', 'deleted.mid');
  const db = databaseBefore007([absolute, 'data/midi/1999-01-01/b.mid', 'midi/2025-10-14/c.mid', deleted]);
  runMigrations(db, dbPath);
  assert.deepEqual(storedPaths(db), [
    'midi/2025-10-14/a.mid',
    'midi/1999-01-01/b.mid',
    'midi/2025-10-14/c.mid',
    'midi/2025-10-14/deleted.mid'
  ]);
  db.close();
});

test('an existing database is backed up before migrating', () => {
  const db = databaseBefore007(['data/midi/1999-01-01/b.mid']);
  runMigrations(db, dbPath);
  db.close();
  assert.deepEqual(backupsIn(dir), ['jamcoda.db.pre-007-library-relative-paths']);
  const backup = new DatabaseSync(path.join(dir, 'jamcoda.db.pre-007-library-relative-paths'), { readOnly: true });
  assert.deepEqual(storedPaths(backup), ['data/midi/1999-01-01/b.mid']);
  backup.close();
});

test('a new database is not backed up', () => {
  const db = new DatabaseSync(dbPath);
  runMigrations(db, dbPath);
  db.close();
  assert.deepEqual(backupsIn(dir), []);
});

test('a refused migration is backed up once however often it is retried', () => {
  const db = databaseBefore007(['/recordings/a.mid']);
  assert.throws(() => runMigrations(db, dbPath), /no midi folder/);
  assert.throws(() => runMigrations(db, dbPath), /no midi folder/);
  assert.deepEqual(backupsIn(dir), ['jamcoda.db.pre-007-library-relative-paths']);
  db.close();
});

test('refuses, changing nothing, when recordings live outside the library', () => {
  const elsewhere = path.join(dir, 'elsewhere');
  const outside = path.join(elsewhere, 'midi', '2025-10-14', 'a.mid');
  mkdirSync(path.dirname(outside), { recursive: true });
  writeFileSync(outside, 'midi');
  const library = path.join(dir, 'library');
  mkdirSync(library);
  dbPath = path.join(library, 'jamcoda.db');
  const db = databaseBefore007([outside, 'data/midi/1999-01-01/b.mid']);
  assert.throws(() => runMigrations(db, dbPath), /must be in its midi folder/);
  assert.deepEqual(storedPaths(db), [outside, 'data/midi/1999-01-01/b.mid']);
  db.close();
});

test('refuses a path on a drive that is not connected', () => {
  const unplugged = path.join(dir, 'Volumes', 'Recordings', 'midi', '2025-10-14', 'a.mid');
  const db = databaseBefore007([unplugged]);
  assert.throws(() => runMigrations(db, dbPath), /cannot be found; connect the drive/);
  assert.deepEqual(storedPaths(db), [unplugged]);
  db.close();
});

test('checks a path already in the library-relative form', () => {
  // `midi/...` relative to the repository, not the library.
  const repo = path.join(dir, 'repo');
  mkdirSync(path.join(repo, 'midi', '2025-10-14'), { recursive: true });
  writeFileSync(path.join(repo, 'midi', '2025-10-14', 'a.mid'), 'midi');
  const library = path.join(dir, 'library');
  mkdirSync(library);
  dbPath = path.join(library, 'jamcoda.db');
  const db = databaseBefore007(['midi/2025-10-14/a.mid']);
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    assert.throws(() => runMigrations(db, dbPath), /expected at/);
  } finally {
    process.chdir(cwd);
  }
  db.close();
});

test('refuses a path with no midi folder', () => {
  const db = databaseBefore007(['/recordings/a.mid']);
  assert.throws(() => runMigrations(db, dbPath), /no midi folder/);
  assert.deepEqual(storedPaths(db), ['/recordings/a.mid']);
  db.close();
});
