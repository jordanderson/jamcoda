import assert from 'node:assert/strict';
import { afterAll as after, beforeAll as before, beforeEach, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

const tempDir = mkdtempSync(join(tmpdir(), 'jamcoda-annotation-'));
const testDbPath = join(tempDir, 'jamcoda.db');
process.env.JAMCODA_DB_PATH = testDbPath;

let initializeDatabase: () => void;
let closeDatabase: () => void;
let getDb: () => Database.Database;
let FileModel: typeof import('./File');
let AnnotationModel: typeof import('./Annotation');
let fileCounter = 0;

function createTestFile(): number {
  fileCounter += 1;
  return FileModel.create({
    jamcorderPath: `/jamcorder/annotation-${fileCounter}.mid`,
    localPath: `data/midi/annotation-${fileCounter}.mid`,
    filename: `annotation-${fileCounter}.mid`,
    fileSize: 2048,
    jamcorderModified: 1710000000 + fileCounter,
    dateRecorded: '2024-01-01'
  });
}

before(async () => {
  const databaseModule = await import('../config/database');
  initializeDatabase = databaseModule.initializeDatabase;
  closeDatabase = databaseModule.closeDatabase;
  getDb = databaseModule.getDb;
  FileModel = await import('./File');
  AnnotationModel = await import('./Annotation');

  initializeDatabase();
});

beforeEach(() => {
  const db = getDb();
  db.exec(`
    DELETE FROM prediction_reviews;
    DELETE FROM annotations;
    DELETE FROM files;
  `);
});

after(() => {
  closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.JAMCODA_DB_PATH;
});

test('countChangedSince counts annotations created or edited after a timestamp', () => {
  const fileId = createTestFile();
  const firstId = AnnotationModel.create({ fileId, songName: 'Song A', startTime: 0, endTime: 10 });
  const secondId = AnnotationModel.create({ fileId, songName: 'Song B', startTime: 10, endTime: 20 });

  const db = getDb();
  db.prepare('UPDATE annotations SET updated_at = ? WHERE id = ?').run(1000, firstId);
  db.prepare('UPDATE annotations SET updated_at = ? WHERE id = ?').run(2000, secondId);

  assert.equal(AnnotationModel.countChangedSince(500), 2);
  assert.equal(AnnotationModel.countChangedSince(1000), 1);
  assert.equal(AnnotationModel.countChangedSince(2000), 0);
  assert.equal(AnnotationModel.countChangedSince(9999), 0);
});

test('split creates two segments with a hole and preserves metadata', () => {
  const fileId = createTestFile();
  const id = AnnotationModel.create({
    fileId,
    songName: 'Song Split',
    startTime: 10,
    endTime: 50,
    notes: 'performance notes'
  });

  const { first, second } = AnnotationModel.split(id, 20, 35);

  assert.equal(first.id, id);
  assert.equal(first.file_id, fileId);
  assert.equal(first.song_name, 'Song Split');
  assert.equal(first.start_time, 10);
  assert.equal(first.end_time, 20);
  assert.equal(first.notes, 'performance notes');

  assert.notEqual(second.id, id);
  assert.equal(second.file_id, fileId);
  assert.equal(second.song_name, 'Song Split');
  assert.equal(second.start_time, 35);
  assert.equal(second.end_time, 50);
  assert.equal(second.notes, 'performance notes');

  const rows = AnnotationModel.findByFileId(fileId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].start_time, 10);
  assert.equal(rows[0].end_time, 20);
  assert.equal(rows[1].start_time, 35);
  assert.equal(rows[1].end_time, 50);
});

test('split rejects invalid or out-of-bounds ranges', () => {
  const fileId = createTestFile();
  const id = AnnotationModel.create({
    fileId,
    songName: 'Song Split Bounds',
    startTime: 10,
    endTime: 50
  });

  // Hole starts at or before annotation start
  assert.throws(() => AnnotationModel.split(id, 10, 20), /Invalid split range/);
  assert.throws(() => AnnotationModel.split(id, 5, 20), /Invalid split range/);

  // Hole ends at or after annotation end
  assert.throws(() => AnnotationModel.split(id, 20, 50), /Invalid split range/);
  assert.throws(() => AnnotationModel.split(id, 20, 55), /Invalid split range/);

  // Inverted hole
  assert.throws(() => AnnotationModel.split(id, 30, 20), /Invalid split range/);
  assert.throws(() => AnnotationModel.split(id, 25, 25), /Invalid split range/);

  // Non-existent id
  assert.throws(() => AnnotationModel.split(99999, 20, 30), /not found/);
});