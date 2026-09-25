import { clipParts, type TimeRange } from './timeRanges';
import { resolveReviewFields } from './predictionReview';
import type { PredictionReview } from './types';

/**
 * How much evidence stands behind each stretch of a predicted segment, and
 * where a reviewer should listen before accepting it.
 *
 * Shared by the review UI, which shades segments and flags stretches, and by
 * `ml:eval`, which measures how often a flag covers a real error, so the rule
 * the reviewer sees is the rule that was measured.
 */

/** A stretch of a predicted segment, as the decoder describes it (`SongSegment.parts`). */
export interface EvidencePart extends TimeRange {
  /**
   * How the decoder reached the song here. `anchor` is recognized outright;
   * `joined` is a gap closed by the post-decode merge; every other value is a
   * song the stretch's own evidence did not settle.
   */
  basis: string;
  /**
   * The song's mean rank over the stretch: how many labels the model scored
   * above it, 0 where it was the model's first choice throughout. Absent for
   * `joined`.
   */
  meanRank?: number;
}

/**
 * A stretch is worth a listen when the decoder filled it in and the model
 * ranked the song, on average, at least this many places below its first
 * choice across it. Over a noodling gap between two sessions of a song the
 * median is 1.8; over every other filled-in stretch it is 0.
 */
export const LISTEN_MIN_MEAN_RANK = 2;

/** ...and when it lasts at least this long, so a flag marks a passage rather than a flicker. */
export const LISTEN_MIN_SEC = 3;

/**
 * 0 to 1: how firmly the model heard the song over a stretch. An anchored
 * stretch is 1, a filled-in one falls with the song's mean rank, and a `joined`
 * gap, which no window of the song covers, is the weakest.
 */
export function evidenceStrength(part: EvidencePart): number {
  if (part.basis === 'anchor') return 1;
  if (part.meanRank === undefined) return 0.15;
  return 0.75 / (1 + part.meanRank);
}

/**
 * The stretches of a segment worth a listen, in time order: consecutive
 * filled-in parts where the song ranks at least `LISTEN_MIN_MEAN_RANK` down,
 * joined into one stretch, and kept when they last `LISTEN_MIN_SEC` or more.
 * `meanRank` is the duration-weighted mean over the joined parts.
 */
export function listenStretches(parts: EvidencePart[]): Array<TimeRange & { meanRank: number }> {
  const stretches: Array<TimeRange & { meanRank: number; weight: number }> = [];
  let open: (TimeRange & { meanRank: number; weight: number }) | null = null;
  for (const part of parts) {
    const qualifies = part.basis !== 'anchor'
      && part.meanRank !== undefined
      && part.meanRank >= LISTEN_MIN_MEAN_RANK;
    if (!qualifies) {
      open = null;
      continue;
    }
    const length = part.endTime - part.startTime;
    if (open && Math.abs(open.endTime - part.startTime) < 1e-6) {
      open.meanRank = (open.meanRank * open.weight + part.meanRank! * length) / (open.weight + length);
      open.weight += length;
      open.endTime = part.endTime;
    } else {
      open = { startTime: part.startTime, endTime: part.endTime, meanRank: part.meanRank!, weight: length };
      stretches.push(open);
    }
  }
  return stretches
    .filter((stretch) => stretch.endTime - stretch.startTime >= LISTEN_MIN_SEC)
    .map(({ startTime, endTime, meanRank }) => ({ startTime, endTime, meanRank }));
}

/**
 * Parse `prediction_reviews.predicted_parts_json`, keeping only well-formed
 * parts. Anything unreadable yields no parts, which reads as "no evidence
 * detail", never as an error: rows written before parts were stored have none.
 */
export function parseEvidenceParts(json: string | null | undefined): EvidencePart[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((part): part is EvidencePart => (
      typeof part === 'object' && part !== null
      && typeof (part as EvidencePart).startTime === 'number'
      && typeof (part as EvidencePart).endTime === 'number'
      && typeof (part as EvidencePart).basis === 'string'
      && ((part as EvidencePart).meanRank === undefined || typeof (part as EvidencePart).meanRank === 'number')
    ));
  } catch {
    return [];
  }
}

/**
 * The evidence parts of a review still awaiting a verdict, fitted to the
 * bounds it resolves to. A reviewed or promoted review has none: the reviewer
 * has already checked the places the parts would flag.
 */
export function partsForReview(review: PredictionReview): EvidencePart[] {
  if (review.status !== 'unsure' || review.promoted_annotation_id !== null) return [];
  const parts = parseEvidenceParts(review.predicted_parts_json);
  if (parts.length === 0) return [];
  const { startTime, endTime } = resolveReviewFields(review);
  return clipParts(parts, startTime, endTime);
}

/** Pieces shorter than this, left over by a cut, are dropped rather than kept. */
export const MIN_CUT_PIECE_SEC = 1;

/**
 * What remains of `[startTime, endTime]` once `[cutStart, cutEnd]` is taken
 * out: up to two pieces, dropping any shorter than `MIN_CUT_PIECE_SEC`. The
 * review modal previews exactly what promoting with that cut will create.
 */
export function cutPieces(startTime: number, endTime: number, cutStart: number, cutEnd: number): TimeRange[] {
  return [
    { startTime, endTime: Math.min(endTime, Math.max(startTime, cutStart)) },
    { startTime: Math.max(startTime, Math.min(endTime, cutEnd)), endTime }
  ].filter((piece) => piece.endTime - piece.startTime >= MIN_CUT_PIECE_SEC);
}
