import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

const tempDir = mkdtempSync(join(tmpdir(), 'jamcoda-annotation-merge-'));
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
    jamcorderPath: `/jamcorder/test-${fileCounter}.mid`,
    localPath: `data/midi/test-${fileCounter}.mid`,
    filename: `test-${fileCounter}.mid`,
    fileSize: 1024,
    jamcorderModified: 1700000000 + fileCounter,
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
    DELETE FROM ignored_sections;
    DELETE FROM annotations;
    DELETE FROM files;
  `);
});

after(() => {
  closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.JAMCODA_DB_PATH;
});

test('merges overlap left-to-right keeping earlier start and later end', () => {
  const fileId = createTestFile();
  const leftId = AnnotationModel.create({
    fileId,
    songName: 'Song A',
    startTime: 10,
    endTime: 20
  });
  AnnotationModel.create({
    fileId,
    songName: 'Song A',
    startTime: 30,
    endTime: 40
  });

  const updated = AnnotationModel.update(leftId, { endTime: 35 });
  assert.equal(updated, true);

  const merged = AnnotationModel.mergeOverlappingSameSong(leftId);
  assert.ok(merged);
  assert.equal(merged.id, leftId);
  assert.equal(merged.start_time, 10);
  assert.equal(merged.end_time, 40);

  const remaining = AnnotationModel.findByFileId(fileId);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, leftId);
  assert.equal(remaining[0].start_time, 10);
  assert.equal(remaining[0].end_time, 40);
});

test('merges overlap right-to-left keeping earlier start and later end', () => {
  const fileId = createTestFile();
  AnnotationModel.create({
    fileId,
    songName: 'Song A',
    startTime: 10,
    endTime: 20
  });
  const rightId = AnnotationModel.create({
    fileId,
    songName: 'Song A',
    startTime: 30,
    endTime: 40
  });

  const updated = AnnotationModel.update(rightId, { startTime: 18 });
  assert.equal(updated, true);

  const merged = AnnotationModel.mergeOverlappingSameSong(rightId);
  assert.ok(merged);
  assert.equal(merged.id, rightId);
  assert.equal(merged.start_time, 10);
  assert.equal(merged.end_time, 40);

  const remaining = AnnotationModel.findByFileId(fileId);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, rightId);
  assert.equal(remaining[0].start_time, 10);
  assert.equal(remaining[0].end_time, 40);
});
