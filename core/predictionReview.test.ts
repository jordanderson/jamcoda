import { describe, expect, it } from 'vitest';
import { resolveReviewFields, usesReviewedValues } from './predictionReview';
import type { PredictionReview, PredictionReviewStatus } from './types';

function review(overrides: Partial<PredictionReview> = {}): PredictionReview {
  return {
    id: 1,
    file_id: 1,
    predicted_song_name: 'Predicted Song',
    predicted_start_time: 10,
    predicted_end_time: 20,
    predicted_confidence: 0.9,
    status: 'unsure',
    reviewed_song_name: null,
    reviewed_start_time: null,
    reviewed_end_time: null,
    review_notes: null,
    model_version: null,
    promoted_annotation_id: null,
    created_at: 0,
    updated_at: 0,
    reviewed_at: null,
    promoted_at: null,
    ...overrides
  };
}

describe('resolveReviewFields', () => {
  it('uses predicted values when nothing was reviewed', () => {
    expect(resolveReviewFields(review())).toEqual({
      songName: 'Predicted Song',
      startTime: 10,
      endTime: 20
    });
  });

  it('uses reviewed values for an edited row', () => {
    const resolved = resolveReviewFields(review({
      status: 'edited',
      reviewed_song_name: 'Reviewed Song',
      reviewed_start_time: 12,
      reviewed_end_time: 18
    }));

    expect(resolved).toEqual({
      songName: 'Reviewed Song',
      startTime: 12,
      endTime: 18
    });
  });

  it('falls back per-field when an edited row only changed some values', () => {
    const resolved = resolveReviewFields(review({
      status: 'edited',
      reviewed_start_time: 12
    }));

    expect(resolved).toEqual({
      songName: 'Predicted Song',
      startTime: 12,
      endTime: 20
    });
  });

  /*
   * The regression this rule was consolidated for. `update()` writes
   * `reviewed_*` and `status` independently, so a row can carry reviewed
   * times while still being `unsure`. The UI and the promotion path both
   * ignored those values, but a `COALESCE` in the ignored-section cleanup
   * query used them, so the two disagreed about which range a row occupied.
   */
  const nonEdited: PredictionReviewStatus[] = ['unsure', 'confirmed', 'invalid'];

  for (const status of nonEdited) {
    it(`ignores reviewed values when status is ${status}`, () => {
      const resolved = resolveReviewFields(review({
        status,
        reviewed_song_name: 'Reviewed Song',
        reviewed_start_time: 90,
        reviewed_end_time: 99
      }));

      expect(resolved).toEqual({
        songName: 'Predicted Song',
        startTime: 10,
        endTime: 20
      });
      expect(usesReviewedValues(status)).toBe(false);
    });
  }
});
