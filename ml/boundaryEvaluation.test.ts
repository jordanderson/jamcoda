import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { matchBoundaries, summarizeBoundaries } from './boundaryEvaluation';
import type { SongSegment } from './songSegmentation';

const segment = (songName: string, startTime: number, endTime: number): SongSegment => ({
  songName, startTime, endTime, durationSec: endTime - startTime, confidence: 0.5
});

describe('boundary evaluation', () => {
  it('reports positive late and negative early errors independently of overlap metrics', () => {
    const matches = matchBoundaries(1, [segment('A', 10, 30), segment('B', 30, 50)],
      [segment('A', 8, 34), segment('B', 34, 49)]);
    assert.equal(matches.length, 2);
    assert.deepEqual(matches.map((row) => [row.startErrorSec, row.endErrorSec]), [[-2, 4], [4, -1]]);
    const summary = summarizeBoundaries(matches, 3, 4);
    assert.equal(summary.start?.meanAbsoluteSec, 3);
    assert.equal(summary.start?.meanSignedSec, 1);
    assert.equal(summary.end?.lateOver2Sec, 0.5);
    assert.equal(summary.unmatchedAnnotations, 1);
    assert.equal(summary.unmatchedPredictions, 2);
  });

  it('does not reuse merged predictions or match wrong songs and tiny fragments', () => {
    const truth = [segment('A', 0, 10), segment('A', 10, 20)];
    assert.equal(matchBoundaries(1, truth, [segment('A', 0, 20)]).length, 1);
    assert.equal(matchBoundaries(1, truth, [segment('B', 0, 10), segment('A', 0, 2)]).length, 0);
    const empty = summarizeBoundaries([], 2, 0);
    assert.equal(empty.start, null);
    assert.equal(empty.end, null);
    assert.equal(empty.unmatchedAnnotations, 2);
  });
});
