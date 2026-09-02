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

test('getReviewQueue returns only unsure rows, excluding settled invalid rows', () => {
  const fileId = createTestFile();
  PredictionReviewModel.create({
    fileId,
    predictedSongName: 'Song A',
    predictedStartTime: 0,
    predictedEndTime: 10
  });
  const rejectedId = PredictionReviewModel.create({
    fileId,
    predictedSongName: 'Song B',
    predictedStartTime: 10,
    predictedEndTime: 20
  });
  const confirmedId = PredictionReviewModel.create({
    fileId,
    predictedSongName: 'Song C',
    predictedStartTime: 20,
    predictedEndTime: 30,
    status: 'confirmed'
  });
  PredictionReviewModel.update(rejectedId, { status: 'invalid' });

  const queue = PredictionReviewModel.getReviewQueue(50, fileId);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, 'unsure');
  assert.notEqual(queue[0].id, rejectedId);
  assert.notEqual(queue[0].id, confirmedId);
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

test('findFileIdsWithOnlyUnsureUnpromoted returns only untouched pending files', () => {
  const untouchedFileId = createTestFile();
  const reviewedFileId = createTestFile();
  const dismissedFileId = createTestFile();
  const promotedFileId = createTestFile();

  PredictionReviewModel.create({
    fileId: untouchedFileId,
    predictedSongName: 'Song A',
    predictedStartTime: 0,
    predictedEndTime: 10
  });
  PredictionReviewModel.create({
    fileId: untouchedFileId,
    predictedSongName: 'Song B',
    predictedStartTime: 10,
    predictedEndTime: 20
  });

  PredictionReviewModel.create({
    fileId: reviewedFileId,
    predictedSongName: 'Song C',
    predictedStartTime: 0,
    predictedEndTime: 10
  });
  const reviewedId = PredictionReviewModel.create({
    fileId: reviewedFileId,
    predictedSongName: 'Song D',
    predictedStartTime: 10,
    predictedEndTime: 20
  });
  PredictionReviewModel.update(reviewedId, { status: 'confirmed' });

  PredictionReviewModel.create({
    fileId: dismissedFileId,
    predictedSongName: 'Song E',
    predictedStartTime: 0,
    predictedEndTime: 10
  });
  const dismissedId = PredictionReviewModel.create({
    fileId: dismissedFileId,
    predictedSongName: 'Song F',
    predictedStartTime: 10,
    predictedEndTime: 20
  });
  PredictionReviewModel.update(dismissedId, { status: 'invalid' });

  const promotedId = PredictionReviewModel.create({
    fileId: promotedFileId,
    predictedSongName: 'Song G',
    predictedStartTime: 0,
    predictedEndTime: 10,
    status: 'confirmed'
  });
  PredictionReviewModel.promoteToAnnotation(promotedId);

  const ids = PredictionReviewModel.findFileIdsWithOnlyUnsureUnpromoted();
  assert.deepEqual(ids, [untouchedFileId]);
});

test('getUnreviewedCoveredSeconds merges overlapping ranges without double-counting', () => {
  const fileId = createTestFile();
  PredictionReviewModel.create({
    fileId,
    predictedSongName: 'Song A',
    predictedStartTime: 0,
    predictedEndTime: 10
  });
  PredictionReviewModel.create({
    fileId,
    predictedSongName: 'Song B',
    predictedStartTime: 5,
    predictedEndTime: 15
  });
  PredictionReviewModel.create({
    fileId,
    predictedSongName: 'Song C',
    predictedStartTime: 20,
    predictedEndTime: 25
  });
  PredictionReviewModel.create({
    fileId,
    predictedSongName: 'Song D',
    predictedStartTime: 30,
    predictedEndTime: 50
  });

  // [0,15] + [20,25] + [30,50] = 15 + 5 + 20 = 40.
  assert.equal(PredictionReviewModel.getUnreviewedCoveredSeconds(fileId), 40);
});

test('getUnreviewedCoveredSeconds counts only unsure unpromoted rows', () => {
  const fileId = createTestFile();
  const confirmedId = PredictionReviewModel.create({
    fileId,
    predictedSongName: 'Song A',
    predictedStartTime: 0,
    predictedEndTime: 100,
    status: 'confirmed'
  });
  const promotedId = PredictionReviewModel.create({
    fileId,
    predictedSongName: 'Song B',
    predictedStartTime: 100,
    predictedEndTime: 200,
    status: 'confirmed'
  });
  PredictionReviewModel.promoteToAnnotation(promotedId);
  PredictionReviewModel.create({
    fileId,
    predictedSongName: 'Song C',
    predictedStartTime: 10,
    predictedEndTime: 40
  });

  // Confirmed and promoted rows are excluded; only [10,40] counts.
  assert.equal(PredictionReviewModel.getUnreviewedCoveredSeconds(fileId), 30);

  // Turning the confirmed row pending makes it count, merging with [10,40].
  PredictionReviewModel.update(confirmedId, { status: 'unsure' });
  assert.equal(PredictionReviewModel.getUnreviewedCoveredSeconds(fileId), 100);

  // A promoted row stays excluded even when marked unsure.
  PredictionReviewModel.update(promotedId, { status: 'unsure' });
  assert.equal(PredictionReviewModel.getUnreviewedCoveredSeconds(fileId), 100);
});

test('getUnreviewedCoveredSeconds returns zero for a file with no pending reviews', () => {
  const fileId = createTestFile();
  assert.equal(PredictionReviewModel.getUnreviewedCoveredSeconds(fileId), 0);
});
