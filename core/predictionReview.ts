import type { PredictionReview, PredictionReviewStatus } from './types';

/**
 * The single definition of how a prediction review resolves to effective
 * values.
 *
 * A review carries both what the model predicted and what a human entered
 * while reviewing. Only a row whose status is `edited` has had its values
 * deliberately changed, so only that status reads from the `reviewed_*`
 * columns. `confirmed` means "the prediction was right as-is", so it still
 * resolves to the predicted values.
 *
 * This rule previously existed in four places: two React components, the
 * promotion helper, and a SQL `COALESCE`. The SQL copy disagreed with the
 * other three: it read `reviewed_*` whenever they were non-null, regardless
 * of status. Because `update()` writes `reviewed_*` and `status`
 * independently, a row could be left `unsure` with reviewed times set, and
 * the two rules then pointed at different time ranges for the same row.
 * Everything now derives from `resolveReviewFields` or from `RESOLVED_*_SQL`
 * below, which encode the same gating.
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
 * shown in the UI, matched against ignored sections, and written to
 * `annotations` on promotion.
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
 * SQL expressions matching `resolveReviewFields`, for queries that must
 * filter on the resolved range without loading rows into JS.
 *
 * Keep these in lockstep with the function above. They are the same rule
 * expressed twice because SQLite cannot call into TypeScript.
 */
export const RESOLVED_START_TIME_SQL =
  `(CASE WHEN status = 'edited' THEN COALESCE(reviewed_start_time, predicted_start_time) ELSE predicted_start_time END)`;

export const RESOLVED_END_TIME_SQL =
  `(CASE WHEN status = 'edited' THEN COALESCE(reviewed_end_time, predicted_end_time) ELSE predicted_end_time END)`;

export const RESOLVED_SONG_NAME_SQL =
  `(CASE WHEN status = 'edited' THEN COALESCE(reviewed_song_name, predicted_song_name) ELSE predicted_song_name END)`;
