import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

const tempDir = mkdtempSync(join(tmpdir(), 'jamcoda-file-'));
const testDbPath = join(tempDir, 'jamcoda.db');
process.env.JAMCODA_DB_PATH = testDbPath;

let initializeDatabase: () => void;
let closeDatabase: () => void;
let getDb: () => Database.Database;
let FileModel: typeof import('./File');
let fileCounter = 0;

function createTestFile(overrides: { midiDuration?: number | null; dateRecorded?: string } = {}): number {
  fileCounter += 1;
  return FileModel.create({
    jamcorderPath: `/jamcorder/file-${fileCounter}.mid`,
    localPath: `data/midi/file-${fileCounter}.mid`,
    filename: `file-${fileCounter}.mid`,
    fileSize: 2048,
    jamcorderModified: 1710000000 + fileCounter,
    dateRecorded: overrides.dateRecorded ?? '2026-02-19',
    midiDuration: 'midiDuration' in overrides ? overrides.midiDuration : 120
  });
}

before(async () => {
  const databaseModule = await import('../config/database');
  initializeDatabase = databaseModule.initializeDatabase;
  closeDatabase = databaseModule.closeDatabase;
  getDb = databaseModule.getDb;
  FileModel = await import('./File');

  initializeDatabase();
});

beforeEach(() => {
  getDb().exec('DELETE FROM files;');
});

after(() => {
  closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.JAMCODA_DB_PATH;
});

test('findByDate hides empty recordings but keeps unparsed ones', () => {
  const played = createTestFile({ midiDuration: 300 });
  createTestFile({ midiDuration: 0 });
  const unparsed = createTestFile({ midiDuration: null });

  const visible = FileModel.findByDate().map((file) => file.id);

  assert.deepEqual(visible.sort(), [played, unparsed].sort());
});

test('findByDate keeps hiding empty recordings inside a date range', () => {
  const played = createTestFile({ midiDuration: 300, dateRecorded: '2026-02-19' });
  createTestFile({ midiDuration: 0, dateRecorded: '2026-02-19' });
  createTestFile({ midiDuration: 900, dateRecorded: '2026-03-05' });

  const visible = FileModel.findByDate('2026-02-01', '2026-02-28').map((file) => file.id);

  assert.deepEqual(visible, [played]);
});

test('findAll still returns empty recordings so sync can skip them', () => {
  createTestFile({ midiDuration: 300 });
  const empty = createTestFile({ midiDuration: 0 });

  const all = FileModel.findAll().map((file) => file.id);

  assert.equal(all.length, 2);
  assert.ok(all.includes(empty));
});

test('countEmptyRecordings counts only zero-duration rows, optionally by range', () => {
  createTestFile({ midiDuration: 300, dateRecorded: '2026-02-19' });
  createTestFile({ midiDuration: 0, dateRecorded: '2026-02-19' });
  createTestFile({ midiDuration: 0, dateRecorded: '2026-02-19' });
  createTestFile({ midiDuration: null, dateRecorded: '2026-02-19' });
  createTestFile({ midiDuration: 0, dateRecorded: '2026-04-11' });

  assert.equal(FileModel.countEmptyRecordings(), 3);
  assert.equal(FileModel.countEmptyRecordings('2026-02-01', '2026-02-28'), 2);
});

test('getResolvedDuration returns the stored duration without re-parsing', () => {
  const id = createTestFile({ midiDuration: 300 });
  const file = FileModel.findById(id);
  assert.ok(file);
  assert.equal(FileModel.getResolvedDuration(file), 300);
});

test('getResolvedDuration backfills and persists a duration for unparsed files', () => {
  const id = createTestFile({ midiDuration: null });
  const file = FileModel.findById(id);
  assert.ok(file);

  // The fake local path cannot be parsed, so it resolves to 0 and the
  // lazy backfill persists that so the next read skips the parse attempt.
  assert.equal(FileModel.getResolvedDuration(file), 0);
  assert.equal(FileModel.findById(id)?.midi_duration, 0);
});
