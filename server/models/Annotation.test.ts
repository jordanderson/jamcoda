import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
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