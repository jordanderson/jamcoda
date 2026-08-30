import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

const tempDir = mkdtempSync(join(tmpdir(), 'jamcoda-prediction-review-'));
const testDbPath = join(tempDir, 'jamcoda.db');
process.env.JAMCODA_DB_PATH = testDbPath;

let initializeDatabase: () => void;
let closeDatabase: () => void;
let getDb: () => Database.Database;
let FileModel: typeof import('./File');
let AnnotationModel: typeof import('./Annotation');
let PredictionReviewModel: typeof import('./PredictionReview');
let fileCounter = 0;

function createTestFile(): number {
  fileCounter += 1;
  return FileModel.create({
    jamcorderPath: `/jamcorder/prediction-${fileCounter}.mid`,
    localPath: `data/midi/prediction-${fileCounter}.mid`,
    filename: `prediction-${fileCounter}.mid`,
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
  PredictionReviewModel = await import('./PredictionReview');

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

test('mergeReviews creates one edited row and marks source rows invalid', () => {
  const fileId = createTestFile();
  const leftId = PredictionReviewModel.create({
    fileId,
    predictedSongName: 'Song A',
    predictedStartTime: 10,
    predictedEndTime: 22,
    predictedConfidence: 0.8
  });
  const rightId = PredictionReviewModel.create({
    fileId,
    predictedSongName: 'Song A',
    predictedStartTime: 22,
    predictedEndTime: 30,
    predictedConfidence: 0.6
  });

  const merged = PredictionReviewModel.mergeReviews([leftId, rightId]);
  assert.equal(merged.replacedCount, 2);
  assert.equal(merged.mergedSongName, 'Song A');
  assert.equal(merged.mergedStartTime, 10);
  assert.equal(merged.mergedEndTime, 30);

  const mergedRow = PredictionReviewModel.findById(merged.mergedReviewId);
  assert.ok(mergedRow);
  assert.equal(mergedRow.status, 'edited');
  assert.equal(mergedRow.reviewed_song_name, 'Song A');
  assert.equal(mergedRow.reviewed_start_time, 10);
  assert.equal(mergedRow.reviewed_end_time, 30);

  const sourceLeft = PredictionReviewModel.findById(leftId);
  const sourceRight = PredictionReviewModel.findById(rightId);
  assert.ok(sourceLeft);
  assert.ok(sourceRight);
  assert.equal(sourceLeft.status, 'invalid');
  assert.equal(sourceRight.status, 'invalid');
  assert.match(sourceLeft.review_notes ?? '', /Merged into review/);
  assert.match(sourceRight.review_notes ?? '', /Merged into review/);
});

test('mergeReviews rejects rows with different resolved song names', () => {
  const fileId = createTestFile();
  const firstId = PredictionReviewModel.create({
    fileId,
    predictedSongName: 'Song A',
    predictedStartTime: 10,
    predictedEndTime: 20
  });
  const secondId = PredictionReviewModel.create({
    fileId,
    predictedSongName: 'Song B',
    predictedStartTime: 20,
    predictedEndTime: 30
  });

  assert.throws(
    () => PredictionReviewModel.mergeReviews([firstId, secondId]),
    /same song name/
  );
});

test('promoteToAnnotation rejects unsure status and promotes confirmed status', () => {
  const fileId = createTestFile();
  const reviewId = PredictionReviewModel.create({
    fileId,
    predictedSongName: 'Song A',
    predictedStartTime: 40,
    predictedEndTime: 55,
    status: 'unsure'
  });

  assert.throws(
    () => PredictionReviewModel.promoteToAnnotation(reviewId),
    /Only confirmed or edited/
  );

  const updated = PredictionReviewModel.update(reviewId, { status: 'confirmed' });
  assert.equal(updated, true);

  const promotion = PredictionReviewModel.promoteToAnnotation(reviewId);
  assert.equal(promotion.created, true);
  assert.ok(promotion.annotationId > 0);

  const annotation = AnnotationModel.findById(promotion.annotationId);
  assert.ok(annotation);
  assert.equal(annotation.song_name, 'Song A');
  assert.equal(annotation.start_time, 40);
  assert.equal(annotation.end_time, 55);

  const promotedReview = PredictionReviewModel.findById(reviewId);
  assert.ok(promotedReview);
  assert.equal(promotedReview.promoted_annotation_id, promotion.annotationId);
});

test('deleteByFileId clears only target file prediction rows', () => {
  const firstFileId = createTestFile();
  const secondFileId = createTestFile();

  PredictionReviewModel.create({
    fileId: firstFileId,
    predictedSongName: 'Song A',
    predictedStartTime: 0,
    predictedEndTime: 10
  });
  PredictionReviewModel.create({
    fileId: firstFileId,
    predictedSongName: 'Song B',
    predictedStartTime: 10,
    predictedEndTime: 20
  });
  PredictionReviewModel.create({
    fileId: secondFileId,
    predictedSongName: 'Song C',
    predictedStartTime: 0,
    predictedEndTime: 10
  });

  const removed = PredictionReviewModel.deleteByFileId(firstFileId);
  assert.equal(removed, 2);
  assert.equal(PredictionReviewModel.count({ fileId: firstFileId }), 0);
  assert.equal(PredictionReviewModel.count({ fileId: secondFileId }), 1);
});

test('renameSongNameReferences updates predicted and reviewed names', () => {
  const fileId = createTestFile();
  PredictionReviewModel.create({
    fileId,
    predictedSongName: 'Old Name',
    predictedStartTime: 5,
    predictedEndTime: 15
  });
  PredictionReviewModel.create({
    fileId,
    predictedSongName: 'Different',
    predictedStartTime: 20,
    predictedEndTime: 30,
    status: 'edited',
    reviewedSongName: 'Old Name',
    reviewedStartTime: 20,
    reviewedEndTime: 30
  });

  const result = PredictionReviewModel.renameSongNameReferences('Old Name', 'New Name');
  assert.equal(result.predictedUpdated, 1);
  assert.equal(result.reviewedUpdated, 1);

  const rows = PredictionReviewModel.list({ fileId, limit: 20 });
  const hasOldName = rows.some((row) =>
    row.predicted_song_name === 'Old Name' || row.reviewed_song_name === 'Old Name'
  );
  assert.equal(hasOldName, false);
});
