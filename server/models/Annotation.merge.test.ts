import assert from 'node:assert/strict';
import { afterAll as after, beforeAll as before, beforeEach, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';

const tempDir = mkdtempSync(join(tmpdir(), 'jamcoda-annotation-merge-'));
const testDbPath = join(tempDir, 'jamcoda.db');
process.env.JAMCODA_DB_PATH = testDbPath;

let initializeDatabase: () => void;
let closeDatabase: () => void;
let getDb: () => DatabaseSync;
let FileModel: typeof import('./File');
let AnnotationModel: typeof import('./Annotation');
let PredictionReviewModel: typeof import('./PredictionReview');
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
  PredictionReviewModel = await import('./PredictionReview');

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
  assert.equal(merged.annotation.id, leftId);
  assert.equal(merged.annotation.start_time, 10);
  assert.equal(merged.annotation.end_time, 40);
  assert.equal(merged.absorbedIds.length, 1);

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
  assert.equal(merged.annotation.id, rightId);
  assert.equal(merged.annotation.start_time, 10);
  assert.equal(merged.annotation.end_time, 40);

  const remaining = AnnotationModel.findByFileId(fileId);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, rightId);
  assert.equal(remaining[0].start_time, 10);
  assert.equal(remaining[0].end_time, 40);
});

/** A confirmed review already promoted into its own annotation. */
function createPromotedReview(fileId: number, songName: string, startTime: number, endTime: number) {
  const reviewId = PredictionReviewModel.create({
    fileId,
    predictedSongName: songName,
    predictedStartTime: startTime,
    predictedEndTime: endTime,
    predictedConfidence: 0.9,
    modelVersion: 'test-model'
  });
  PredictionReviewModel.update(reviewId, { status: 'confirmed' });
  const { annotationId } = PredictionReviewModel.promoteToAnnotation(reviewId);
  assert.ok(annotationId);
  return { reviewId, annotationId };
}

test('absorbing a promoted annotation re-points its review at the survivor', () => {
  const fileId = createTestFile();
  const survivorId = AnnotationModel.create({
    fileId,
    songName: 'Song A',
    startTime: 0,
    endTime: 10
  });
  const { reviewId, annotationId } = createPromotedReview(fileId, 'Song A', 20, 30);

  AnnotationModel.update(survivorId, { endTime: 25 });
  const merged = AnnotationModel.mergeOverlappingSameSong(survivorId);
  assert.ok(merged);
  assert.equal(merged.annotation.id, survivorId);
  assert.equal(merged.annotation.end_time, 30);
  assert.equal(AnnotationModel.findById(annotationId), undefined);

  // The promotion follows the merge instead of being nulled by the foreign key.
  const review = PredictionReviewModel.findById(reviewId);
  assert.ok(review);
  assert.equal(review.promoted_annotation_id, survivorId);
  assert.ok(review.promoted_at);

  // So it stays off the detail view's roll and list.
  const unpromoted = PredictionReviewModel.list({ fileId, includePromoted: false, limit: 500 });
  assert.equal(unpromoted.length, 0);
  assert.equal(PredictionReviewModel.listPromotableUnpromoted(100, fileId).length, 0);

  // And re-promoting reuses the survivor rather than creating a duplicate.
  const repromoted = PredictionReviewModel.promoteToAnnotation(reviewId);
  assert.equal(repromoted.created, false);
  assert.equal(AnnotationModel.findByFileId(fileId).length, 1);
});

test('absorbing several promoted annotations re-points every review', () => {
  const fileId = createTestFile();
  const first = createPromotedReview(fileId, 'Song A', 0, 10);
  const second = createPromotedReview(fileId, 'Song A', 20, 30);
  const survivorId = AnnotationModel.create({
    fileId,
    songName: 'Song A',
    startTime: 40,
    endTime: 50
  });

  AnnotationModel.update(survivorId, { startTime: 5 });
  const merged = AnnotationModel.mergeOverlappingSameSong(survivorId);
  assert.ok(merged);
  assert.equal(merged.annotation.start_time, 0);
  assert.equal(merged.annotation.end_time, 50);
  assert.deepEqual(
    [...merged.absorbedIds].sort((a, b) => a - b),
    [first.annotationId, second.annotationId].sort((a, b) => a - b)
  );

  for (const { reviewId } of [first, second]) {
    const review = PredictionReviewModel.findById(reviewId);
    assert.ok(review);
    assert.equal(review.promoted_annotation_id, survivorId);
  }
  assert.equal(PredictionReviewModel.list({ fileId, includePromoted: false, limit: 500 }).length, 0);
});

test('a promoted annotation that survives the merge keeps its own review link', () => {
  const fileId = createTestFile();
  const { reviewId, annotationId } = createPromotedReview(fileId, 'Song A', 0, 10);
  AnnotationModel.create({
    fileId,
    songName: 'Song A',
    startTime: 20,
    endTime: 30
  });

  AnnotationModel.update(annotationId, { endTime: 25 });
  const merged = AnnotationModel.mergeOverlappingSameSong(annotationId);
  assert.ok(merged);
  assert.equal(merged.annotation.id, annotationId);
  assert.equal(merged.annotation.end_time, 30);

  const review = PredictionReviewModel.findById(reviewId);
  assert.ok(review);
  assert.equal(review.promoted_annotation_id, annotationId);
});

test('deleting a promoted annotation clears the whole promotion', () => {
  const fileId = createTestFile();
  const { reviewId, annotationId } = createPromotedReview(fileId, 'Song A', 0, 10);

  assert.equal(AnnotationModel.remove(annotationId), true);

  // Un-promoting is intended here, but it must not leave a promoted_at behind
  // for a promotion that no longer exists.
  const review = PredictionReviewModel.findById(reviewId);
  assert.ok(review);
  assert.equal(review.promoted_annotation_id, null);
  assert.equal(review.promoted_at, null);
  assert.equal(review.status, 'confirmed');

  // The review is promotable again and comes back to the detail view.
  assert.equal(PredictionReviewModel.list({ fileId, includePromoted: false, limit: 500 }).length, 1);
  assert.equal(PredictionReviewModel.listPromotableUnpromoted(100, fileId).length, 1);
});

test('deleting an unrelated annotation leaves promotions untouched', () => {
  const fileId = createTestFile();
  const { reviewId, annotationId } = createPromotedReview(fileId, 'Song A', 0, 10);
  const otherId = AnnotationModel.create({
    fileId,
    songName: 'Song B',
    startTime: 20,
    endTime: 30
  });

  assert.equal(AnnotationModel.remove(otherId), true);

  const review = PredictionReviewModel.findById(reviewId);
  assert.ok(review);
  assert.equal(review.promoted_annotation_id, annotationId);
  assert.ok(review.promoted_at);
});

test('re-promoting a re-pointed review does not shrink the merged annotation', () => {
  const fileId = createTestFile();
  const survivorId = AnnotationModel.create({
    fileId,
    songName: 'Song A',
    startTime: 0,
    endTime: 10
  });
  const { reviewId } = createPromotedReview(fileId, 'Song A', 20, 30);

  AnnotationModel.update(survivorId, { endTime: 25 });
  AnnotationModel.mergeOverlappingSameSong(survivorId);

  PredictionReviewModel.promoteToAnnotation(reviewId);

  const survivor = AnnotationModel.findById(survivorId);
  assert.ok(survivor);
  assert.equal(survivor.start_time, 0);
  assert.equal(survivor.end_time, 30);
  assert.equal(AnnotationModel.findByFileId(fileId).length, 1);
});

test('re-promoting a review that still owns its annotation updates it in place', () => {
  const fileId = createTestFile();
  const { reviewId, annotationId } = createPromotedReview(fileId, 'Song A', 10, 20);

  // Widen the review, then promote again: the annotation it exclusively owns
  // should still follow the review.
  PredictionReviewModel.update(reviewId, {
    status: 'edited',
    reviewedSongName: 'Song A',
    reviewedStartTime: 5,
    reviewedEndTime: 25
  });
  const result = PredictionReviewModel.promoteToAnnotation(reviewId);
  assert.equal(result.created, false);
  assert.equal(result.annotationId, annotationId);

  const annotation = AnnotationModel.findById(annotationId);
  assert.ok(annotation);
  assert.equal(annotation.start_time, 5);
  assert.equal(annotation.end_time, 25);
});

/**
 * Deliberate trade-off. `promoteToAnnotation` skips the in-place rewrite
 * when the linked annotation covers more than the review: a single review
 * can exclusively own a merged survivor, and shrinking it would undo the
 * merge. The cost is that narrowing a review no longer narrows its
 * annotation. Promote is only offered for unpromoted reviews in the UI, so
 * this path is reachable through the API alone.
 */
test('re-promoting a narrowed review leaves its wider annotation alone', () => {
  const fileId = createTestFile();
  const { reviewId, annotationId } = createPromotedReview(fileId, 'Song A', 10, 40);

  PredictionReviewModel.update(reviewId, {
    status: 'edited',
    reviewedSongName: 'Song A',
    reviewedStartTime: 20,
    reviewedEndTime: 30
  });
  const result = PredictionReviewModel.promoteToAnnotation(reviewId);
  assert.equal(result.created, false);
  assert.equal(result.annotationId, annotationId);

  const annotation = AnnotationModel.findById(annotationId);
  assert.ok(annotation);
  assert.equal(annotation.start_time, 10);
  assert.equal(annotation.end_time, 40);
});

test('an edit that absorbs nothing reports no absorbed ids', () => {
  const fileId = createTestFile();
  const id = AnnotationModel.create({
    fileId,
    songName: 'Song A',
    startTime: 10,
    endTime: 20
  });
  AnnotationModel.create({
    fileId,
    songName: 'Song B',
    startTime: 30,
    endTime: 40
  });

  // A plain resize that reaches no same-song neighbour. The empty list is what
  // lets the detail page patch its cache instead of refetching the file.
  AnnotationModel.update(id, { endTime: 25 });
  const merged = AnnotationModel.mergeOverlappingSameSong(id);
  assert.ok(merged);
  assert.equal(merged.annotation.end_time, 25);
  assert.deepEqual(merged.absorbedIds, []);
  assert.equal(AnnotationModel.findByFileId(fileId).length, 2);
});

test('an overlapping neighbour of a different song is not absorbed', () => {
  const fileId = createTestFile();
  const id = AnnotationModel.create({
    fileId,
    songName: 'Song A',
    startTime: 10,
    endTime: 20
  });
  AnnotationModel.create({
    fileId,
    songName: 'Song B',
    startTime: 22,
    endTime: 40
  });

  AnnotationModel.update(id, { endTime: 30 });
  const merged = AnnotationModel.mergeOverlappingSameSong(id);
  assert.ok(merged);
  assert.deepEqual(merged.absorbedIds, []);
  assert.equal(AnnotationModel.findByFileId(fileId).length, 2);
});
