import { getDb } from '@config/database';
import {
  RESOLVED_END_TIME_SQL,
  RESOLVED_START_TIME_SQL,
  isPredictionReviewStatus as isStatus,
  resolveReviewFields
} from '@core/predictionReview';
import type {
  CreatePredictionReviewData,
  ListPredictionReviewsFilters,
  MergePredictionReviewsResult,
  PredictionReview,
  PredictionReviewStatus,
  PromotePredictionReviewResult,
  UpdatePredictionReviewData
} from '@server/types';

/** Type guard for validating untrusted status input. */
export const isPredictionReviewStatus = isStatus;

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function buildListWhere(filters: ListPredictionReviewsFilters): {
  whereSql: string;
  params: Array<string | number>;
} {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (filters.fileId !== undefined) {
    where.push('file_id = ?');
    params.push(filters.fileId);
  }

  if (filters.status !== undefined) {
    where.push('status = ?');
    params.push(filters.status);
  }

  if (filters.includePromoted === false) {
    where.push('promoted_annotation_id IS NULL');
  }

  return {
    whereSql: where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '',
    params
  };
}

function shouldSetReviewedAt(status: PredictionReviewStatus, data: {
  reviewedSongName?: string | null;
  reviewedStartTime?: number | null;
  reviewedEndTime?: number | null;
  reviewNotes?: string | null;
}): boolean {
  if (status !== 'unsure') {
    return true;
  }
  return (
    data.reviewedSongName !== undefined
    || data.reviewedStartTime !== undefined
    || data.reviewedEndTime !== undefined
    || data.reviewNotes !== undefined
  );
}

/** Fetch one review row by primary key. */
export function findById(id: number): PredictionReview | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM prediction_reviews WHERE id = ?').get(id) as PredictionReview | undefined;
}

/** List reviews with optional filtering and pagination. */
export function list(filters: ListPredictionReviewsFilters = {}): PredictionReview[] {
  const db = getDb();
  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;
  const where = buildListWhere(filters);

  const sql = `
    SELECT *
    FROM prediction_reviews
    ${where.whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `;

  return db.prepare(sql).all(...where.params, limit, offset) as PredictionReview[];
}

/** Count reviews matching the same filter contract as `list`. */
export function count(filters: ListPredictionReviewsFilters = {}): number {
  const db = getDb();
  const where = buildListWhere(filters);

  const sql = `
    SELECT COUNT(*) as count
    FROM prediction_reviews
    ${where.whereSql}
  `;

  const row = db.prepare(sql).get(...where.params) as { count: number };
  return row.count;
}

/**
 * Total seconds covered by the union of a file's pending review ranges.
 *
 * Pending means the same set the browse "Unreviewed" pill counts: unpromoted
 * rows still `unsure`. Overlapping segments are merged before summing, so two
 * overlapping predictions do not double-count the covered duration.
 *
 * Ranges use `RESOLVED_*_SQL` so the resolved-value rule stays defined once,
 * in `core/predictionReview.ts`.
 */
export function getUnreviewedCoveredSeconds(fileId: number): number {
  const db = getDb();
  const row = db.prepare(`
    WITH ranges AS (
      SELECT
        ${RESOLVED_START_TIME_SQL} AS range_start,
        ${RESOLVED_END_TIME_SQL} AS range_end
      FROM prediction_reviews
      WHERE file_id = ?
        AND status = 'unsure'
        AND promoted_annotation_id IS NULL
    ),
    marked AS (
      SELECT
        range_start,
        range_end,
        CASE
          WHEN range_start <= MAX(range_end) OVER (
            ORDER BY range_start, range_end
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ) THEN 0
          ELSE 1
        END AS starts_new_group
      FROM ranges
    ),
    grouped AS (
      SELECT
        range_start,
        range_end,
        SUM(starts_new_group) OVER (ORDER BY range_start, range_end) AS grp
      FROM marked
    )
    SELECT COALESCE(SUM(group_length), 0) AS covered_seconds
    FROM (
      SELECT
        MAX(range_end) - MIN(range_start) AS group_length
      FROM grouped
      GROUP BY grp
    )
  `).get(fileId) as { covered_seconds: number } | undefined;
  return row?.covered_seconds ?? 0;
}

/** Insert a single prediction review row. */
export function create(data: CreatePredictionReviewData): number {
  const db = getDb();
  const now = nowUnix();
  const status = data.status ?? 'unsure';
  const reviewedAt = shouldSetReviewedAt(status, data) ? now : null;

  const result = db.prepare(`
    INSERT INTO prediction_reviews (
      file_id,
      predicted_song_name,
      predicted_start_time,
      predicted_end_time,
      predicted_confidence,
      status,
      reviewed_song_name,
      reviewed_start_time,
      reviewed_end_time,
      review_notes,
      model_version,
      created_at,
      updated_at,
      reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.fileId,
    data.predictedSongName,
    data.predictedStartTime,
    data.predictedEndTime,
    data.predictedConfidence ?? null,
    status,
    data.reviewedSongName ?? null,
    data.reviewedStartTime ?? null,
    data.reviewedEndTime ?? null,
    data.reviewNotes ?? null,
    data.modelVersion ?? null,
    now,
    now,
    reviewedAt
  );

  return result.lastInsertRowid as number;
}

/** Insert many prediction review rows in one transaction. */
export function createMany(items: CreatePredictionReviewData[]): number[] {
  const db = getDb();
  const now = nowUnix();
  const ids: number[] = [];

  const insert = db.prepare(`
    INSERT INTO prediction_reviews (
      file_id,
      predicted_song_name,
      predicted_start_time,
      predicted_end_time,
      predicted_confidence,
      status,
      reviewed_song_name,
      reviewed_start_time,
      reviewed_end_time,
      review_notes,
      model_version,
      created_at,
      updated_at,
      reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((rows: CreatePredictionReviewData[]) => {
    for (const item of rows) {
      const status = item.status ?? 'unsure';
      const reviewedAt = shouldSetReviewedAt(status, item) ? now : null;

      const result = insert.run(
        item.fileId,
        item.predictedSongName,
        item.predictedStartTime,
        item.predictedEndTime,
        item.predictedConfidence ?? null,
        status,
        item.reviewedSongName ?? null,
        item.reviewedStartTime ?? null,
        item.reviewedEndTime ?? null,
        item.reviewNotes ?? null,
        item.modelVersion ?? null,
        now,
        now,
        reviewedAt
      );
      ids.push(result.lastInsertRowid as number);
    }
  });

  tx(items);
  return ids;
}

/** Update a review row; returns false when nothing was changed/found. */
export function update(id: number, data: UpdatePredictionReviewData): boolean {
  const db = getDb();
  const updates: string[] = [];
  const values: Array<string | number | null> = [];
  const now = nowUnix();

  if (data.status !== undefined) {
    updates.push('status = ?');
    values.push(data.status);
  }
  if (data.reviewedSongName !== undefined) {
    updates.push('reviewed_song_name = ?');
    values.push(data.reviewedSongName);
  }
  if (data.reviewedStartTime !== undefined) {
    updates.push('reviewed_start_time = ?');
    values.push(data.reviewedStartTime);
  }
  if (data.reviewedEndTime !== undefined) {
    updates.push('reviewed_end_time = ?');
    values.push(data.reviewedEndTime);
  }
  if (data.reviewNotes !== undefined) {
    updates.push('review_notes = ?');
    values.push(data.reviewNotes);
  }
  if (data.modelVersion !== undefined) {
    updates.push('model_version = ?');
    values.push(data.modelVersion);
  }

  if (updates.length === 0) {
    return false;
  }

  const hasReviewPayload = (
    data.reviewedSongName !== undefined
    || data.reviewedStartTime !== undefined
    || data.reviewedEndTime !== undefined
    || data.reviewNotes !== undefined
  );

  if (data.status === 'unsure') {
    updates.push('reviewed_at = NULL');
  } else if (data.status !== undefined || hasReviewPayload) {
    updates.push('reviewed_at = ?');
    values.push(now);
  }

  updates.push('updated_at = ?');
  values.push(now);
  values.push(id);

  const query = `UPDATE prediction_reviews SET ${updates.join(', ')} WHERE id = ?`;
  const result = db.prepare(query).run(...values);
  return result.changes > 0;
}

/**
 * Queue candidates prioritized for manual review. `invalid` rows are
 * already settled, so only unpromoted `unsure` rows still need a human.
 */
export function getReviewQueue(limit = 50, fileId?: number): PredictionReview[] {
  const db = getDb();
  const params: Array<number> = [];
  let whereSql = `
    WHERE promoted_annotation_id IS NULL
      AND status = 'unsure'
  `;

  if (fileId !== undefined) {
    whereSql += ' AND file_id = ?';
    params.push(fileId);
  }

  const sql = `
    SELECT *
    FROM prediction_reviews
    ${whereSql}
    ORDER BY
      CASE WHEN predicted_confidence IS NULL THEN 0.5 ELSE predicted_confidence END ASC,
      (predicted_end_time - predicted_start_time) ASC,
      created_at DESC
    LIMIT ?
  `;

  return db.prepare(sql).all(...params, limit) as PredictionReview[];
}

/** List reviewed rows that are eligible for annotation promotion. */
export function listPromotableUnpromoted(limit = 100, fileId?: number): PredictionReview[] {
  const db = getDb();
  const params: Array<number> = [];
  let whereSql = `
    WHERE promoted_annotation_id IS NULL
      AND status IN ('confirmed', 'edited')
  `;

  if (fileId !== undefined) {
    whereSql += ' AND file_id = ?';
    params.push(fileId);
  }

  const sql = `
    SELECT *
    FROM prediction_reviews
    ${whereSql}
    ORDER BY reviewed_at DESC, created_at DESC
    LIMIT ?
  `;

  return db.prepare(sql).all(...params, limit) as PredictionReview[];
}

/**
 * File ids whose unpromoted queue is entirely `unsure` — nothing has been
 * reviewed yet. Safe to re-score after a model rebuild: the re-run pipeline
 * uses `deleteUnpromotedByFileId`, which would otherwise wipe reviewed rows.
 */
export function findFileIdsWithOnlyUnsureUnpromoted(): number[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT pr.file_id
    FROM prediction_reviews pr
    WHERE pr.promoted_annotation_id IS NULL
      AND pr.status = 'unsure'
      AND NOT EXISTS (
        SELECT 1
        FROM prediction_reviews other
        WHERE other.file_id = pr.file_id
          AND other.promoted_annotation_id IS NULL
          AND other.status <> 'unsure'
      )
  `).all() as Array<{ file_id: number }>;
  return rows.map((row) => row.file_id);
}

/** Delete all unpromoted review rows for one file. */
export function deleteUnpromotedByFileId(fileId: number): number {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM prediction_reviews
    WHERE file_id = ?
      AND promoted_annotation_id IS NULL
  `).run(fileId);
  return result.changes;
}

/** Delete unpromoted rows whose effective range overlaps `[startTime, endTime)`. */
export function deleteUnpromotedOverlappingRange(
  fileId: number,
  startTime: number,
  endTime: number
): number {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM prediction_reviews
    WHERE file_id = ?
      AND promoted_annotation_id IS NULL
      AND ${RESOLVED_END_TIME_SQL} > ?
      AND ${RESOLVED_START_TIME_SQL} < ?
  `).run(fileId, startTime, endTime);
  return result.changes;
}

/** Delete all review rows for a file (promoted and unpromoted). */
export function deleteByFileId(fileId: number): number {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM prediction_reviews
    WHERE file_id = ?
  `).run(fileId);
  return result.changes;
}

/** Rename song references in both predicted and reviewed song-name fields. */
export function renameSongNameReferences(oldSongName: string, newSongName: string): {
  predictedUpdated: number;
  reviewedUpdated: number;
} {
  const db = getDb();
  const now = nowUnix();

  const tx = db.transaction(() => {
    const predictedResult = db.prepare(`
      UPDATE prediction_reviews
      SET predicted_song_name = ?, updated_at = ?
      WHERE predicted_song_name = ?
    `).run(newSongName, now, oldSongName);

    const reviewedResult = db.prepare(`
      UPDATE prediction_reviews
      SET reviewed_song_name = ?, updated_at = ?
      WHERE reviewed_song_name = ?
    `).run(newSongName, now, oldSongName);

    return {
      predictedUpdated: predictedResult.changes,
      reviewedUpdated: reviewedResult.changes
    };
  });

  return tx();
}

/**
 * Merge multiple review rows into one edited row.
 * Source rows are marked `invalid` and annotated with merge notes.
 */
export function mergeReviews(reviewIds: number[]): MergePredictionReviewsResult {
  const db = getDb();
  const uniqueIds = [...new Set(reviewIds.filter((id) => Number.isInteger(id) && id > 0))];

  if (uniqueIds.length < 2) {
    throw new Error('Select at least 2 reviews to merge.');
  }

  const tx = db.transaction(() => {
    const reviews = uniqueIds
      .map((id) => findById(id))
      .filter((review): review is PredictionReview => review !== undefined);

    if (reviews.length !== uniqueIds.length) {
      throw new Error('One or more selected reviews were not found.');
    }

    for (const review of reviews) {
      if (review.promoted_annotation_id !== null) {
        throw new Error(`Review #${review.id} is already promoted and cannot be merged.`);
      }
    }

    const fileId = reviews[0].file_id;
    if (!reviews.every((review) => review.file_id === fileId)) {
      throw new Error('All selected reviews must belong to the same file.');
    }

    const resolved = reviews.map((review) => ({
      review,
      promotion: resolveReviewFields(review)
    }));

    const mergedSongName = resolved[0].promotion.songName;
    if (!resolved.every((item) => item.promotion.songName === mergedSongName)) {
      throw new Error('All selected reviews must have the same song name.');
    }

    const mergedStartTime = Math.min(...resolved.map((item) => item.promotion.startTime));
    const mergedEndTime = Math.max(...resolved.map((item) => item.promotion.endTime));
    if (!(Number.isFinite(mergedStartTime) && Number.isFinite(mergedEndTime) && mergedStartTime < mergedEndTime)) {
      throw new Error('Merged segment has an invalid time range.');
    }

    const confidences = reviews
      .map((review) => review.predicted_confidence)
      .filter((value): value is number => value !== null && Number.isFinite(value));
    const mergedConfidence = confidences.length > 0
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : null;

    const modelVersion = reviews.find((review) => review.model_version !== null)?.model_version ?? null;
    const now = nowUnix();
    const mergeNote = `Merged from review IDs: ${uniqueIds.join(', ')}`;

    const mergedInsert = db.prepare(`
      INSERT INTO prediction_reviews (
        file_id,
        predicted_song_name,
        predicted_start_time,
        predicted_end_time,
        predicted_confidence,
        status,
        reviewed_song_name,
        reviewed_start_time,
        reviewed_end_time,
        review_notes,
        model_version,
        created_at,
        updated_at,
        reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fileId,
      mergedSongName,
      mergedStartTime,
      mergedEndTime,
      mergedConfidence,
      'edited',
      mergedSongName,
      mergedStartTime,
      mergedEndTime,
      mergeNote,
      modelVersion,
      now,
      now,
      now
    );
    const mergedReviewId = mergedInsert.lastInsertRowid as number;

    const replacedNote = `Merged into review #${mergedReviewId}`;
    const markMerged = db.prepare(`
      UPDATE prediction_reviews
      SET status = 'invalid',
          review_notes = CASE
            WHEN review_notes IS NULL OR TRIM(review_notes) = '' THEN ?
            ELSE review_notes || '\n' || ?
          END,
          reviewed_at = COALESCE(reviewed_at, ?),
          updated_at = ?
      WHERE id = ?
    `);
    for (const id of uniqueIds) {
      markMerged.run(replacedNote, replacedNote, now, now, id);
    }

    const mergedReview = findById(mergedReviewId);
    if (!mergedReview) {
      throw new Error('Merged review could not be loaded.');
    }

    return {
      mergedReview,
      mergedReviewId,
      mergedSongName,
      mergedStartTime,
      mergedEndTime,
      replacedReviewIds: uniqueIds,
      replacedCount: uniqueIds.length
    } satisfies MergePredictionReviewsResult;
  });

  return tx();
}

/**
 * Promote a confirmed/edited review into `annotations`.
 * Reuses existing promoted annotation when available; otherwise creates one.
 */
export function promoteToAnnotation(id: number): PromotePredictionReviewResult {
  const db = getDb();
  const existing = findById(id);
  if (!existing) {
    throw new Error('Prediction review not found.');
  }
  if (existing.status !== 'confirmed' && existing.status !== 'edited') {
    throw new Error('Only confirmed or edited reviews can be promoted.');
  }

  const promotion = resolveReviewFields(existing);
  if (!(
    Number.isFinite(promotion.startTime)
    && Number.isFinite(promotion.endTime)
    && promotion.startTime < promotion.endTime
  )) {
    throw new Error('Cannot promote review with invalid time range.');
  }

  const now = nowUnix();

  const tx = db.transaction(() => {
    let annotationId = existing.promoted_annotation_id;
    let created = false;

    if (annotationId !== null) {
      const row = db.prepare(
        'SELECT id, start_time, end_time FROM annotations WHERE id = ?'
      ).get(annotationId) as { id: number; start_time: number; end_time: number } | undefined;
      if (row) {
        // A same-song merge re-points absorbed reviews at the surviving
        // annotation, so the link can name a row that covers more than this
        // one review. Rewrite only when this review exclusively owns the
        // annotation; shrinking it would undo the merge.
        const sharedWithOtherReview = (db.prepare(`
          SELECT COUNT(*) AS count
          FROM prediction_reviews
          WHERE promoted_annotation_id = ? AND id != ?
        `).get(annotationId, existing.id) as { count: number }).count > 0;

        const coversMoreThanReview = (
          row.start_time < promotion.startTime || row.end_time > promotion.endTime
        );

        if (!sharedWithOtherReview && !coversMoreThanReview) {
          db.prepare(`
            UPDATE annotations
            SET file_id = ?, song_name = ?, start_time = ?, end_time = ?, updated_at = ?
            WHERE id = ?
          `).run(
            existing.file_id,
            promotion.songName,
            promotion.startTime,
            promotion.endTime,
            now,
            annotationId
          );
        }
      } else {
        annotationId = null;
      }
    }

    if (annotationId === null) {
      const result = db.prepare(`
        INSERT INTO annotations (
          file_id,
          song_name,
          start_time,
          end_time,
          notes,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        existing.file_id,
        promotion.songName,
        promotion.startTime,
        promotion.endTime,
        `Promoted from prediction review #${existing.id}`,
        now,
        now
      );
      annotationId = result.lastInsertRowid as number;
      created = true;
    }

    db.prepare(`
      UPDATE prediction_reviews
      SET promoted_annotation_id = ?,
          promoted_at = ?,
          reviewed_at = COALESCE(reviewed_at, ?),
          updated_at = ?
      WHERE id = ?
    `).run(annotationId, now, now, now, existing.id);

    const updated = findById(existing.id);
    if (!updated) {
      throw new Error('Prediction review disappeared after promotion.');
    }

    return {
      review: updated,
      annotationId,
      created
    } satisfies PromotePredictionReviewResult;
  });

  return tx();
}
