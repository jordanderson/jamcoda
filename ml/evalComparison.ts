import type { BoundaryMatch } from './boundaryEvaluation';
import type { SessionScoreRow, SessionScoreSummary } from './sessionEvaluation';
import type { AnnotationInterval } from './songSegmentation';

/**
 * Paired comparison of two `ml:eval` reports.
 *
 * Aggregate metrics move for two different reasons: the same takes were
 * predicted better, or a different set of takes was recognized at all. Only the
 * first is an improvement in boundary placement, so every statistic here is
 * computed over the annotations both runs matched, and the ones only one run
 * matched are reported as counts rather than folded into a mean.
 */

export interface ComparableFileRow {
  fileId: number;
  annotationSec: number;
  matchedSec: number;
  predictedSec: number;
  predictedMatchedSec: number;
}

export interface ComparableReport {
  dataset: { sha256: string; manifest: Array<{ fileId: number; isComplete: boolean; annotations: AnnotationInterval[] }> };
  segmentComplete: { annotationRecall: number; segmentPrecision: number; segmentF1: number };
  byFileSegment: ComparableFileRow[];
  boundaryMatchesComplete: BoundaryMatch[];
  /** Absent from reports written before session scoring. */
  sessionByFileComplete?: SessionScoreRow[];
  sessionComplete?: SessionScoreSummary;
}

const matchKey = (match: Pick<BoundaryMatch, 'fileId' | 'annotationIndex'>) =>
  `${match.fileId}:${match.annotationIndex}`;

/** Segment F1 over a chosen set of per-file rows, exactly as `ml:eval` sums it. */
export function f1OverFiles(rows: ComparableFileRow[]): number {
  let annotationSec = 0, matchedSec = 0, predictedSec = 0, predictedMatchedSec = 0;
  for (const row of rows) {
    annotationSec += row.annotationSec;
    matchedSec += row.matchedSec;
    predictedSec += row.predictedSec;
    predictedMatchedSec += row.predictedMatchedSec;
  }
  if (annotationSec <= 0 || predictedSec <= 0) return 0;
  const recall = matchedSec / annotationSec;
  const precision = predictedMatchedSec / predictedSec;
  return recall + precision <= 0 ? 0 : (2 * recall * precision) / (recall + precision);
}

/** Deterministic RNG so a reported interval can be reproduced from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile interval for the F1 difference, resampling whole files.
 *
 * Files are the independent unit here: takes within one recording share a
 * player, a piano and a session. This describes variability across the files in
 * this library; it is not a held-out test and the folds share training data.
 */
export function bootstrapF1DeltaPoints(
  baseline: ComparableFileRow[],
  variant: ComparableFileRow[],
  options: { resamples?: number; seed?: number } = {}
): { deltaPoints: number; ci95: [number, number]; resamples: number; seed: number } {
  const resamples = options.resamples ?? 3000;
  const seed = options.seed ?? 42;
  const variantById = new Map(variant.map((row) => [row.fileId, row]));
  const paired = baseline
    .filter((row) => variantById.has(row.fileId))
    .map((row) => [row, variantById.get(row.fileId)!] as const);
  const deltaPoints = (f1OverFiles(paired.map((p) => p[1])) - f1OverFiles(paired.map((p) => p[0]))) * 100;
  if (paired.length === 0) return { deltaPoints: 0, ci95: [0, 0], resamples, seed };

  const random = mulberry32(seed);
  const deltas: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const baseSample: ComparableFileRow[] = [];
    const variantSample: ComparableFileRow[] = [];
    for (let i = 0; i < paired.length; i++) {
      const pick = paired[Math.floor(random() * paired.length)];
      baseSample.push(pick[0]);
      variantSample.push(pick[1]);
    }
    deltas.push((f1OverFiles(variantSample) - f1OverFiles(baseSample)) * 100);
  }
  deltas.sort((a, b) => a - b);
  const at = (p: number) => deltas[Math.min(deltas.length - 1, Math.max(0, Math.round(p * (deltas.length - 1))))];
  return { deltaPoints, ci95: [at(0.025), at(0.975)], resamples, seed };
}

/**
 * Session totals compared: the review-cost view of the same two runs. Lower is
 * better for every one of them.
 */
export const SESSION_COMPARED = {
  wrongSongSec: (row: SessionScoreRow) => row.wrongSongSec,
  missedSec: (row: SessionScoreRow) => row.missedSec,
  bleedSec: (row: SessionScoreRow) => row.bleedSec,
  gapFillSec: (row: SessionScoreRow) => row.gapFillSec,
  overrunSec: (row: SessionScoreRow) => row.overrunSec,
  strayBleedSec: (row: SessionScoreRow) => row.strayBleedSec,
  gapsBridged: (row: SessionScoreRow) => row.gapsBridged,
  sessionsSplit: (row: SessionScoreRow) => row.sessionsSplit,
  sessionsMissed: (row: SessionScoreRow) => row.sessions - row.sessionsFound,
  unsupportedSegments: (row: SessionScoreRow) => row.unsupportedSegments,
  reviewEdits: (row: SessionScoreRow) => row.reviewEdits
} as const;

export type SessionMetric = keyof typeof SESSION_COMPARED;

export interface SessionMetricDelta {
  baseline: number;
  variant: number;
  delta: number;
  /** File bootstrap interval for `delta`. */
  ci95: [number, number];
}

/**
 * Each session total for both runs, with a percentile interval for the
 * difference from resampling whole files, as `bootstrapF1DeltaPoints` does.
 * One resample draws the same files for every metric.
 */
export function compareSessionTotals(
  baseline: SessionScoreRow[],
  variant: SessionScoreRow[],
  options: { resamples?: number; seed?: number } = {}
): Record<SessionMetric, SessionMetricDelta> {
  const resamples = options.resamples ?? 3000;
  const random = mulberry32(options.seed ?? 42);
  const variantById = new Map(variant.map((row) => [row.fileId, row]));
  const paired = baseline
    .filter((row) => variantById.has(row.fileId))
    .map((row) => [row, variantById.get(row.fileId)!] as const);
  const metrics = Object.keys(SESSION_COMPARED) as SessionMetric[];
  const deltaOf = (metric: SessionMetric, pair: typeof paired[number]) =>
    SESSION_COMPARED[metric](pair[1]) - SESSION_COMPARED[metric](pair[0]);

  const samples = new Map(metrics.map((metric) => [metric, [] as number[]]));
  for (let r = 0; r < resamples && paired.length > 0; r++) {
    const sums = new Map(metrics.map((metric) => [metric, 0]));
    for (let i = 0; i < paired.length; i++) {
      const pick = paired[Math.floor(random() * paired.length)];
      for (const metric of metrics) sums.set(metric, sums.get(metric)! + deltaOf(metric, pick));
    }
    for (const metric of metrics) samples.get(metric)!.push(sums.get(metric)!);
  }

  const result = {} as Record<SessionMetric, SessionMetricDelta>;
  for (const metric of metrics) {
    const total = (side: 0 | 1) => paired.reduce((sum, pair) => sum + SESSION_COMPARED[metric](pair[side]), 0);
    const sorted = samples.get(metric)!.sort((a, b) => a - b);
    const at = (p: number) => sorted.length === 0
      ? 0
      : sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
    result[metric] = {
      baseline: total(0),
      variant: total(1),
      delta: total(1) - total(0),
      ci95: [at(0.025), at(0.975)]
    };
  }
  return result;
}

export interface PairedErrors {
  baselineMeanAbsoluteSec: number;
  variantMeanAbsoluteSec: number;
  baselineMedianSignedSec: number;
  variantMedianSignedSec: number;
  improved: number;
  worsened: number;
  unchanged: number;
}

const median = (values: number[]) => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

function pairedErrors(pairs: Array<[number, number]>): PairedErrors {
  let improved = 0, worsened = 0, unchanged = 0;
  for (const [before, after] of pairs) {
    if (Math.abs(after) < Math.abs(before)) improved++;
    else if (Math.abs(after) > Math.abs(before)) worsened++;
    else unchanged++;
  }
  return {
    baselineMeanAbsoluteSec: mean(pairs.map((p) => Math.abs(p[0]))),
    variantMeanAbsoluteSec: mean(pairs.map((p) => Math.abs(p[1]))),
    baselineMedianSignedSec: median(pairs.map((p) => p[0])),
    variantMedianSignedSec: median(pairs.map((p) => p[1])),
    improved, worsened, unchanged
  };
}

export interface CloseTransition {
  fileId: number;
  from: string;
  to: string;
  gapSec: number;
  baselineEndErrorSec: number;
  baselineNextStartErrorSec: number;
  variantEndErrorSec: number;
  variantNextStartErrorSec: number;
}

/**
 * Adjacent different-song annotation pairs that both runs matched at both ends.
 * This is the reported symptom — one take ending as the next begins — isolated
 * from take starts and ends in general.
 */
export function closeTransitions(
  report: ComparableReport,
  baselineMatches: BoundaryMatch[],
  variantMatches: BoundaryMatch[],
  maxGapSec = 2
): CloseTransition[] {
  const baseline = new Map(baselineMatches.map((m) => [matchKey(m), m]));
  const variant = new Map(variantMatches.map((m) => [matchKey(m), m]));
  const transitions: CloseTransition[] = [];
  for (const file of report.dataset.manifest) {
    if (!file.isComplete) continue;
    for (let i = 0; i + 1 < file.annotations.length; i++) {
      const left = file.annotations[i];
      const right = file.annotations[i + 1];
      if (left.songName === right.songName) continue;
      const gapSec = right.startTime - left.endTime;
      if (gapSec < 0 || gapSec > maxGapSec) continue;
      const keys = [`${file.fileId}:${i}`, `${file.fileId}:${i + 1}`];
      if (!keys.every((k) => baseline.has(k) && variant.has(k))) continue;
      transitions.push({
        fileId: file.fileId, from: left.songName, to: right.songName, gapSec,
        baselineEndErrorSec: baseline.get(keys[0])!.endErrorSec,
        baselineNextStartErrorSec: baseline.get(keys[1])!.startErrorSec,
        variantEndErrorSec: variant.get(keys[0])!.endErrorSec,
        variantNextStartErrorSec: variant.get(keys[1])!.startErrorSec
      });
    }
  }
  return transitions;
}

export function compareReports(
  baseline: ComparableReport,
  variant: ComparableReport,
  options: { resamples?: number; seed?: number; maxGapSec?: number } = {}
) {
  if (baseline.dataset.sha256 !== variant.dataset.sha256) {
    throw new Error(
      `Reports describe different datasets (${baseline.dataset.sha256} vs ${variant.dataset.sha256}).`
      + ' Only runs over identical annotations and MIDI are comparable.'
    );
  }
  const completeIds = new Set(baseline.dataset.manifest.filter((f) => f.isComplete).map((f) => f.fileId));
  const completeRows = (report: ComparableReport) => report.byFileSegment.filter((row) => completeIds.has(row.fileId));

  const baselineByKey = new Map(baseline.boundaryMatchesComplete.map((m) => [matchKey(m), m]));
  const variantByKey = new Map(variant.boundaryMatchesComplete.map((m) => [matchKey(m), m]));
  const commonKeys = [...baselineByKey.keys()].filter((key) => variantByKey.has(key));
  const start: Array<[number, number]> = [];
  const end: Array<[number, number]> = [];
  for (const key of commonKeys) {
    start.push([baselineByKey.get(key)!.startErrorSec, variantByKey.get(key)!.startErrorSec]);
    end.push([baselineByKey.get(key)!.endErrorSec, variantByKey.get(key)!.endErrorSec]);
  }

  const transitions = closeTransitions(
    baseline, baseline.boundaryMatchesComplete, variant.boundaryMatchesComplete, options.maxGapSec
  );

  return {
    datasetSha256: baseline.dataset.sha256,
    f1: {
      baselinePoints: baseline.segmentComplete.segmentF1 * 100,
      variantPoints: variant.segmentComplete.segmentF1 * 100,
      ...bootstrapF1DeltaPoints(completeRows(baseline), completeRows(variant), options)
    },
    matches: {
      baseline: baselineByKey.size,
      variant: variantByKey.size,
      common: commonKeys.length,
      lostByVariant: baselineByKey.size - commonKeys.length,
      gainedByVariant: variantByKey.size - commonKeys.length
    },
    paired: { startErrorSec: pairedErrors(start), endErrorSec: pairedErrors(end) },
    sessions: baseline.sessionByFileComplete && variant.sessionByFileComplete
      ? compareSessionTotals(baseline.sessionByFileComplete, variant.sessionByFileComplete, options)
      : null,
    closeTransitions: {
      count: transitions.length,
      baselineMedianEndSec: median(transitions.map((t) => t.baselineEndErrorSec)),
      baselineMedianNextStartSec: median(transitions.map((t) => t.baselineNextStartErrorSec)),
      variantMedianEndSec: median(transitions.map((t) => t.variantEndErrorSec)),
      variantMedianNextStartSec: median(transitions.map((t) => t.variantNextStartErrorSec)),
      transitions
    }
  };
}
