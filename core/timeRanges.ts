/**
 * Time-range algebra for the prediction-import pipeline, shared by the HTTP
 * route (`POST /api/prediction-reviews/run`) and the `ml:predict-import` CLI.
 */

export interface TimeRange {
  startTime: number;
  endTime: number;
}

/** A predicted segment carries its song and confidence alongside its range. */
export interface RangedSegment extends TimeRange {
  songName: string;
  durationSec: number;
  confidence: number;
  /** Stretches covering the segment in time order; clipped with it by `clipParts`. */
  parts?: TimeRange[];
}

/**
 * `parts` fitted to `[startTime, endTime]`: parts outside it are dropped, the
 * rest clamped, and the first and last stretched to its edges, so they still
 * cover the whole range after its boundaries moved or it was cut into pieces.
 */
export function clipParts<P extends TimeRange>(parts: P[], startTime: number, endTime: number): P[] {
  const clipped = parts
    .filter((part) => part.endTime > startTime && part.startTime < endTime)
    .map((part) => ({
      ...part,
      startTime: Math.max(part.startTime, startTime),
      endTime: Math.min(part.endTime, endTime)
    }));
  if (clipped.length > 0) {
    clipped[0].startTime = startTime;
    clipped[clipped.length - 1].endTime = endTime;
  }
  return clipped;
}

/** Append `[startTime, endTime)` as a piece of `segment`, if it is long enough. */
function pushPiece<T extends RangedSegment>(
  into: T[],
  segment: T,
  startTime: number,
  endTime: number,
  minSegmentSec: number
): void {
  const durationSec = endTime - startTime;
  if (durationSec >= minSegmentSec) {
    into.push({
      ...segment,
      startTime,
      endTime,
      durationSec,
      ...(segment.parts ? { parts: clipParts(segment.parts, startTime, endTime) } : {})
    });
  }
}

function isUsableRange(range: TimeRange): boolean {
  return (
    Number.isFinite(range.startTime)
    && Number.isFinite(range.endTime)
    && range.endTime > range.startTime
  );
}

/**
 * Sort, drop degenerate entries, and merge overlapping/touching ranges into a
 * minimal non-overlapping set ordered by start time.
 */
export function normalizeRanges(ranges: TimeRange[]): TimeRange[] {
  if (ranges.length === 0) return [];

  const sorted = ranges
    .filter(isUsableRange)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);

  if (sorted.length === 0) return [];

  const merged: TimeRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.startTime <= last.endTime) {
      last.endTime = Math.max(last.endTime, current.endTime);
      continue;
    }
    merged.push({ ...current });
  }

  return merged;
}

/**
 * Subtract `excludedRanges` from each segment, keeping only the surviving
 * pieces that are at least `minSegmentSec` long.
 *
 * A segment straddling an excluded range is split, so the result can contain
 * more entries than the input. See `countModifiedSegments` before reporting
 * anything derived from the length difference.
 */
export function removeExcludedRangesFromSegments<T extends RangedSegment>(
  segments: T[],
  excludedRanges: TimeRange[],
  minSegmentSec: number
): T[] {
  if (segments.length === 0 || excludedRanges.length === 0) {
    return segments;
  }

  const excluded = normalizeRanges(excludedRanges);
  if (excluded.length === 0) {
    return segments;
  }

  const kept: T[] = [];

  for (const segment of segments) {
    let cursor = segment.startTime;

    for (const range of excluded) {
      if (range.endTime <= cursor) continue;
      if (range.startTime >= segment.endTime) break;

      const keptEnd = Math.min(range.startTime, segment.endTime);
      if (keptEnd > cursor) {
        pushPiece(kept, segment, cursor, keptEnd, minSegmentSec);
      }

      cursor = Math.max(cursor, range.endTime);
      if (cursor >= segment.endTime) break;
    }

    if (cursor < segment.endTime) {
      pushPiece(kept, segment, cursor, segment.endTime, minSegmentSec);
    }
  }

  return kept;
}

/** Identity of a segment's song and exact range, for set membership. */
function rangeKey(segment: RangedSegment): string {
  return JSON.stringify([segment.songName, segment.startTime, segment.endTime]);
}

/**
 * How many of the original segments were dropped or altered by exclusion.
 *
 * Comparing array lengths is wrong: splitting one segment around an excluded
 * region yields two, which can mask real changes or go negative. This counts
 * segments whose range no longer survives unchanged.
 */
export function countModifiedSegments<T extends RangedSegment>(
  before: T[],
  after: T[]
): number {
  const surviving = new Set(after.map(rangeKey));

  let modified = 0;
  for (const segment of before) {
    if (!surviving.has(rangeKey(segment))) {
      modified++;
    }
  }
  return modified;
}

/**
 * Split segments at the given playback-time points (e.g. Jamcorder passage
 * bookmarks), dropping any resulting piece shorter than `minSegmentSec`.
 *
 * A bookmark marks the end of a user-selected passage. The app treats those
 * boundaries as intentional, so predicted segments are cut there rather than
 * merging across a device-marked passage change.
 */
export function splitSegmentsAtTimes<T extends RangedSegment>(
  segments: T[],
  splitTimes: number[],
  minSegmentSec: number
): T[] {
  if (segments.length === 0 || splitTimes.length === 0) {
    return segments;
  }

  const times = [...new Set(splitTimes)]
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b);
  if (times.length === 0) {
    return segments;
  }

  const kept: T[] = [];

  for (const segment of segments) {
    let cursor = segment.startTime;
    for (const time of times) {
      if (time <= cursor) continue;
      if (time >= segment.endTime) break;
      pushPiece(kept, segment, cursor, time, minSegmentSec);
      cursor = time;
    }
    pushPiece(kept, segment, cursor, segment.endTime, minSegmentSec);
  }

  return kept;
}
