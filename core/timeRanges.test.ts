import { describe, expect, it } from 'vitest';
import {
  countModifiedSegments,
  normalizeRanges,
  removeExcludedRangesFromSegments,
  type RangedSegment
} from './timeRanges';

function segment(startTime: number, endTime: number, songName = 'Song'): RangedSegment {
  return { songName, startTime, endTime, durationSec: endTime - startTime, confidence: 0.9 };
}

describe('normalizeRanges', () => {
  it('sorts and merges overlapping ranges', () => {
    expect(normalizeRanges([
      { startTime: 30, endTime: 40 },
      { startTime: 0, endTime: 10 },
      { startTime: 5, endTime: 20 }
    ])).toEqual([
      { startTime: 0, endTime: 20 },
      { startTime: 30, endTime: 40 }
    ]);
  });

  it('merges ranges that only touch', () => {
    expect(normalizeRanges([
      { startTime: 0, endTime: 10 },
      { startTime: 10, endTime: 20 }
    ])).toEqual([{ startTime: 0, endTime: 20 }]);
  });

  it('drops zero-length and non-finite ranges', () => {
    expect(normalizeRanges([
      { startTime: 5, endTime: 5 },
      { startTime: 10, endTime: 8 },
      { startTime: NaN, endTime: 4 }
    ])).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [{ startTime: 0, endTime: 10 }, { startTime: 5, endTime: 20 }];
    normalizeRanges(input);
    expect(input).toEqual([{ startTime: 0, endTime: 10 }, { startTime: 5, endTime: 20 }]);
  });
});

describe('removeExcludedRangesFromSegments', () => {
  it('returns segments untouched when nothing is excluded', () => {
    const segments = [segment(0, 30)];
    expect(removeExcludedRangesFromSegments(segments, [], 5)).toBe(segments);
  });

  it('trims a segment overlapping the start of an excluded range', () => {
    expect(removeExcludedRangesFromSegments(
      [segment(0, 30)],
      [{ startTime: 20, endTime: 40 }],
      5
    )).toEqual([segment(0, 20)]);
  });

  it('splits a segment straddling an excluded range', () => {
    expect(removeExcludedRangesFromSegments(
      [segment(0, 60)],
      [{ startTime: 20, endTime: 30 }],
      5
    )).toEqual([segment(0, 20), segment(30, 60)]);
  });

  it('drops surviving pieces shorter than the minimum', () => {
    // The 0-2s remainder is below the 5s floor and is discarded.
    expect(removeExcludedRangesFromSegments(
      [segment(0, 60)],
      [{ startTime: 2, endTime: 30 }],
      5
    )).toEqual([segment(30, 60)]);
  });

  it('drops a segment entirely inside an excluded range', () => {
    expect(removeExcludedRangesFromSegments(
      [segment(10, 20)],
      [{ startTime: 0, endTime: 40 }],
      5
    )).toEqual([]);
  });

  it('recomputes durationSec on the pieces it keeps', () => {
    const [kept] = removeExcludedRangesFromSegments(
      [segment(0, 60)],
      [{ startTime: 40, endTime: 50 }],
      5
    );
    expect(kept.durationSec).toBe(40);
  });
});

describe('countModifiedSegments', () => {
  it('counts nothing when segments pass through unchanged', () => {
    const before = [segment(0, 30), segment(40, 70)];
    expect(countModifiedSegments(before, before)).toBe(0);
  });

  /*
   * Why this exists rather than comparing array lengths: splitting one segment
   * yields two, so `after.length - before.length` is +1 for a segment that was
   * very much modified, and the old `Math.max(0, ...)` reported 0.
   */
  it('counts a split segment as modified even though the count grew', () => {
    const before = [segment(0, 60)];
    const after = removeExcludedRangesFromSegments(before, [{ startTime: 20, endTime: 30 }], 5);

    expect(after).toHaveLength(2);
    expect(countModifiedSegments(before, after)).toBe(1);
  });

  it('counts a dropped segment', () => {
    const before = [segment(0, 30), segment(40, 70)];
    const after = [segment(0, 30)];
    expect(countModifiedSegments(before, after)).toBe(1);
  });
});
