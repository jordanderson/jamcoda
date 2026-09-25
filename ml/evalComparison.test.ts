import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  bootstrapF1DeltaPoints, closeTransitions, compareReports, compareSessionTotals, f1OverFiles
} from './evalComparison';
import { scoreSessions } from './sessionEvaluation';
import type { BoundaryMatch } from './boundaryEvaluation';
import type { ComparableFileRow, ComparableReport } from './evalComparison';

const file = (fileId: number, matchedSec: number, predictedMatchedSec: number): ComparableFileRow =>
  ({ fileId, annotationSec: 100, matchedSec, predictedSec: 100, predictedMatchedSec });

const match = (fileId: number, annotationIndex: number, startErrorSec: number, endErrorSec: number): BoundaryMatch =>
  ({ fileId, annotationIndex, songName: 'A', segmentIndex: annotationIndex, iou: 0.9, startErrorSec, endErrorSec });

const report = (over: Partial<ComparableReport> = {}): ComparableReport => ({
  dataset: {
    sha256: 'dataset-one',
    manifest: [{
      fileId: 1, isComplete: true,
      annotations: [
        { songName: 'A', startTime: 0, endTime: 100 },
        { songName: 'B', startTime: 101, endTime: 200 },
        { songName: 'C', startTime: 260, endTime: 300 }
      ]
    }, {
      fileId: 2, isComplete: false,
      annotations: [{ songName: 'A', startTime: 0, endTime: 50 }, { songName: 'B', startTime: 51, endTime: 90 }]
    }]
  },
  segmentComplete: { annotationRecall: 0.9, segmentPrecision: 0.9, segmentF1: 0.9 },
  byFileSegment: [file(1, 90, 90), file(2, 10, 10)],
  boundaryMatchesComplete: [match(1, 0, 0, 8), match(1, 1, 5, 1)],
  ...over
});

describe('paired evaluation comparison', () => {
  it('refuses reports from different datasets', () => {
    const other = report({ dataset: { sha256: 'dataset-two', manifest: [] } });
    assert.throws(() => compareReports(report(), other), /different datasets/);
  });

  it('separates common-annotation error changes from changes in what was matched', () => {
    const variant = report({
      // Annotation 1 is no longer matched; annotation 2 is matched for the first time.
      boundaryMatchesComplete: [match(1, 0, -1, 2), match(1, 2, 3, 3)]
    });
    const result = compareReports(report(), variant, { resamples: 50 });
    assert.deepEqual(result.matches, { baseline: 2, variant: 2, common: 1, lostByVariant: 1, gainedByVariant: 1 });
    // Only annotation 0 is common: end 8s late -> 2s late, start 0s -> 1s early.
    assert.equal(result.paired.endErrorSec.improved, 1);
    assert.equal(result.paired.endErrorSec.worsened, 0);
    assert.equal(result.paired.endErrorSec.baselineMeanAbsoluteSec, 8);
    assert.equal(result.paired.endErrorSec.variantMeanAbsoluteSec, 2);
    assert.equal(result.paired.startErrorSec.worsened, 1);
  });

  it('counts an unchanged error as neither improved nor worsened', () => {
    const result = compareReports(report(), report(), { resamples: 50 });
    assert.equal(result.paired.endErrorSec.unchanged, 2);
    assert.equal(result.paired.endErrorSec.improved, 0);
    assert.equal(result.paired.endErrorSec.worsened, 0);
    assert.equal(result.f1.deltaPoints, 0);
  });

  it('scores close transitions only on complete files where both runs matched both takes', () => {
    const base = report();
    // A ends at 100 and B starts at 101 (1s apart, different songs) -> counted.
    // B -> C is 60s apart -> not a close transition. File 2 is incomplete.
    const transitions = closeTransitions(base, base.boundaryMatchesComplete, base.boundaryMatchesComplete);
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].from, 'A');
    assert.equal(transitions[0].to, 'B');
    assert.equal(transitions[0].baselineEndErrorSec, 8);
    assert.equal(transitions[0].baselineNextStartErrorSec, 5);
    // Drop annotation 1 from the variant and the pair no longer qualifies.
    assert.equal(closeTransitions(base, base.boundaryMatchesComplete, [match(1, 0, 0, 8)]).length, 0);
  });

  it('computes F1 over whole files and bootstraps only the complete ones', () => {
    assert.equal(f1OverFiles([file(1, 50, 50), file(2, 100, 100)]), 0.75);
    assert.equal(f1OverFiles([]), 0);
    const variant = report({ byFileSegment: [file(1, 100, 100), file(2, 0, 0)] });
    const result = compareReports(report(), variant, { resamples: 200, seed: 7 });
    // File 2 is incomplete, so its collapse must not appear in the delta.
    assert.ok(result.f1.deltaPoints > 0, `expected a positive delta, got ${result.f1.deltaPoints}`);
    assert.equal(result.f1.seed, 7);
    assert.ok(result.f1.ci95[0] <= result.f1.deltaPoints && result.f1.deltaPoints <= result.f1.ci95[1]);
  });

  it('is deterministic for a seed and widens when the gain rests on fewer files', () => {
    const even = { baseline: [] as ComparableFileRow[], variant: [] as ComparableFileRow[] };
    const lumpy = { baseline: [] as ComparableFileRow[], variant: [] as ComparableFileRow[] };
    for (let id = 1; id <= 20; id++) {
      // Every file improves by the same 2 points, versus a spread of per-file
      // gains that resampling can actually land differently.
      even.baseline.push(file(id, 90, 90));
      even.variant.push(file(id, 92, 92));
      lumpy.baseline.push(file(id, 60, 60));
      lumpy.variant.push(file(id, 60 + id, 60 + id));
    }
    const run = (set: typeof even, seed: number) =>
      bootstrapF1DeltaPoints(set.baseline, set.variant, { resamples: 800, seed });
    const width = (r: ReturnType<typeof run>) => r.ci95[1] - r.ci95[0];
    // Every file improving identically leaves nothing for resampling to vary.
    assert.equal(width(run(even, 1)), 0);
    const first = run(lumpy, 1);
    assert.deepEqual(run(lumpy, 1).ci95, first.ci95, 'same seed must reproduce the interval');
    assert.notDeepEqual(run(lumpy, 2).ci95, first.ci95, 'a different seed must resample differently');
    assert.ok(width(first) > 0,
      'a gain resting on one file must carry a non-zero interval');
  });
});

describe('session totals comparison', () => {
  const segment = (songName: string, startTime: number, endTime: number) =>
    ({ songName, startTime, endTime, durationSec: endTime - startTime, confidence: 0.5 });
  const sessions = [
    { songName: 'A', startTime: 0, endTime: 100 },
    { songName: 'A', startTime: 110, endTime: 200 }
  ];

  it('reports each total for both runs, with an interval around the difference', () => {
    const baseline = [1, 2, 3].map((id) => scoreSessions(id, sessions, [segment('A', 0, 100), segment('A', 110, 200)], 200));
    const variant = [1, 2, 3].map((id) => scoreSessions(id, sessions, [segment('A', 0, 200)], 200));
    const result = compareSessionTotals(baseline, variant, { resamples: 200, seed: 3 });

    assert.deepEqual(
      [result.gapsBridged.baseline, result.gapsBridged.variant, result.gapsBridged.delta],
      [0, 3, 3]
    );
    assert.equal(result.gapFillSec.delta, 30);
    assert.deepEqual(result.gapsBridged.ci95, [3, 3], 'every file changed alike, so resampling cannot vary it');
    assert.equal(result.reviewEdits.delta, 3);
  });

  it('is left out when a report predates session scoring', () => {
    assert.equal(compareReports(report(), report()).sessions, null);
  });
});
