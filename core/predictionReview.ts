import type { PredictionReview, PredictionReviewStatus } from './types';

/**
 * How a prediction review resolves to its effective values.
 *
 * A review carries both what the model predicted and what a reviewer entered.
 * Only `edited` means the values were deliberately changed, so only `edited`
 * reads the `reviewed_*` columns; `confirmed` means "right as-is" and still
 * resolves to the predicted values.
 *
 * `update()` writes `reviewed_*` and `status` independently, so a row can hold
 * reviewed times while still `unsure`. Gate on status, never on the columns
 * being non-null -- a bare `COALESCE` is the bug this module exists to avoid.
 */

export const PREDICTION_REVIEW_STATUSES: readonly PredictionReviewStatus[] = [
  'confirmed',
  'edited',
  'invalid',
  'unsure'
];

export function isPredictionReviewStatus(value: unknown): value is PredictionReviewStatus {
  return typeof value === 'string'
    && (PREDICTION_REVIEW_STATUSES as readonly string[]).includes(value);
}

/** Only `edited` rows take their values from the reviewer's edits. */
export function usesReviewedValues(status: PredictionReviewStatus): boolean {
  return status === 'edited';
}

export interface ResolvedReviewFields {
  songName: string;
  startTime: number;
  endTime: number;
}

/**
 * Resolve the effective song name and time range for a review -- the values
 * shown in the UI and written to `annotations` on promotion.
 */
export function resolveReviewFields(review: PredictionReview): ResolvedReviewFields {
  const useReviewed = usesReviewedValues(review.status);

  return {
    songName: useReviewed && review.reviewed_song_name
      ? review.reviewed_song_name
      : review.predicted_song_name,
    startTime: useReviewed && review.reviewed_start_time !== null
      ? review.reviewed_start_time
      : review.predicted_start_time,
    endTime: useReviewed && review.reviewed_end_time !== null
      ? review.reviewed_end_time
      : review.predicted_end_time
  };
}

/**
 * `resolveReviewFields` as SQL, for queries that filter on the resolved range
 * without loading rows into JS. Change both together.
 */
export const RESOLVED_START_TIME_SQL =
  `(CASE WHEN status = 'edited' THEN COALESCE(reviewed_start_time, predicted_start_time) ELSE predicted_start_time END)`;

export const RESOLVED_END_TIME_SQL =
  `(CASE WHEN status = 'edited' THEN COALESCE(reviewed_end_time, predicted_end_time) ELSE predicted_end_time END)`;

export const RESOLVED_SONG_NAME_SQL =
  `(CASE WHEN status = 'edited' THEN COALESCE(reviewed_song_name, predicted_song_name) ELSE predicted_song_name END)`;
