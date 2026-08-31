import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseNoteSequence } from '@core/midi/noteSequence';
import { clamp, ensureDirForFile, roundTo } from '@core/cli/args';

export const NO_SONG_LABEL = '__none__';

/**
 * Version 2 features:
 *
 * The first 7 entries are carried over from v1 (pitch-class durations plus
 * onset/pitch/velocity/duration/polyphony aggregates). The rest capture
 * characteristics that matter for real piano practice sessions:
 *
 *   velocity_std / duration_std / polyphony_std   articulation and texture spread
 *   silence_ratio                                 how much of the window is dead air
 *   pitch_span                                    register width of the phrase
 *   tempo_bpm                                     median inter-onset interval tempo
 *   regularity                                    peak autocorrelation of the onset
 *                                                 density (rhythmic pulse strength)
 */
const FEATURE_NAMES = [
  'pc_C',
  'pc_C#',
  'pc_D',
  'pc_D#',
  'pc_E',
  'pc_F',
  'pc_F#',
  'pc_G',
  'pc_G#',
  'pc_A',
  'pc_A#',
  'pc_B',
  'onset_density',
  'mean_pitch',
  'pitch_std',
  'mean_velocity',
  'mean_duration',
  'mean_polyphony',
  'velocity_std',
  'duration_std',
  'polyphony_std',
  'silence_ratio',
  'pitch_span',
  'tempo_bpm',
  'regularity'
] as const;

/** Sub-window bin used for polyphony spread and silence-ratio estimates. */
const POLYPHONY_BIN_SEC = 0.25;
/** Sub-window bin used for onset regularity (autocorrelation) estimates. */
const REGULARITY_BIN_SEC = 0.1;

export interface AnnotationInterval {
  songName: string;
  startTime: number;
  endTime: number;
}

export interface AnnotatedMidiFile {
  fileId: number;
  filename: string;
  midiPath: string;
  annotations: AnnotationInterval[];
}

export interface NoteEvent {
  pitch: number;
  velocity: number;
  startSec: number;
  endSec: number;
}

export interface WindowSample {
  fileId: number;
  fileName: string;
  startTime: number;
  endTime: number;
  label: string;
  features: number[];
}

export interface TrainConfig {
  windowSec: number;
  stepSec: number;
  /** Kept for v1 compatibility; v2 prediction is prototype-based. */
  k: number;
  maxNoneToSongRatio: number;
  /** Total prototype budget across all labels (default 1200). */
  prototypeBudget?: number;
  /** Hard cap on how many prototypes the __none__ class may keep (default 120). */
  maxNonePrototypes?: number;
  /** exp(-d/sigma) kernel scale; 0 means derive from training data (default 0). */
  kernelScale?: number;
  /** 'anchor' (default), 'viterbi', or 'smooth' sequential decoding. */
  decoder?: 'anchor' | 'smooth' | 'viterbi';
  /** Log-space penalty for switching label between adjacent windows (default 1.0). */
  viterbiChangePenalty?: number;
  /** Softmax temperature for per-window emission scores (default 1.0). */
  temperature?: number;
  /** Feature normalization: 'zscore' (v1 behaviour), 'minmax' (default), 'none'. */
  featureScaling?: 'zscore' | 'minmax' | 'none';
  /** v2 per-label score aggregation: 'min' (nearest prototype, default) or 'avg'. */
  scoreMode?: 'min' | 'avg';
  /** Anchor-link decoder: minimum margin for an anchor seed window (default 0.15). */
  anchorMargin?: number;
  /** Anchor-link decoder: minimum consecutive anchor windows forming a seed run (default 3). */
  minAnchorRun?: number;
  /** Anchor-link decoder: minimum margin for a window to be linked into a run (default 0). */
  fillMinMargin?: number;
  /** Anchor-link decoder: a linked window must rank the run's label within its
   *  top-K labels (default -1, i.e. no affinity check -- aggressive linking). */
  fillTopK?: number;
  /** Anchor-link decoder: confidence assigned to linked (filled) windows (default 0.5). */
  linkConfidence?: number;
}

export interface SongSegmentModel {
  modelType: 'knn-song-segmenter';
  version: 1 | 2;
  createdAt: string;
  config: TrainConfig;
  featureNames: string[];
  labels: string[];
  featureMeans: number[];
  featureStds: number[];
  /** v1: raw standardized training vectors used by classic k-NN. */
  trainingVectors?: number[][];
  trainingLabelIndices?: number[];
  /** v2: condensed per-label prototypes with their label index. */
  prototypes?: Array<{ features: number[]; labelIndex: number }>;
  /** v2: number of prototypes kept per label (used for score normalization). */
  prototypeCounts?: number[];
  /** v2: kernel scale for exp(-d/sigma). */
  kernelScale?: number;
  trainingSummary: {
    filesUsed: number;
    annotationsUsed: number;
    totalSamples: number;
    positiveSamples: number;
    noneSamples: number;
    labelCounts: Record<string, number>;
  };
}

export interface WindowPrediction {
  startTime: number;
  endTime: number;
  label: string;
  confidence: number;
}

export interface SongSegment {
  songName: string;
  startTime: number;
  endTime: number;
  durationSec: number;
  confidence: number;
}

export interface PredictConfig {
  minWindowConfidence: number;
  smoothingWindows: number;
  minSegmentSec: number;
  minSegmentConfidence: number;
  mergeGapSec: number;
}

export interface LeaveOneOutFold {
  fileId: number;
  filename: string;
  totalWindows: number;
  overallAccuracy: number;
  songWindows: number;
  songAccuracy: number;
}

export interface LeaveOneOutEvaluation {
  folds: LeaveOneOutFold[];
  meanOverallAccuracy: number;
  meanSongAccuracy: number;
}

interface AnnotationSqlRow {
  file_id: number;
  song_name: string;
  start_time: number;
  end_time: number;
  local_path: string;
  filename: string;
}

function toNum(value: unknown): number {
  if (typeof value === 'number') return value;
  return Number(value);
}

/**
 * Read-only query against the app database.
 *
 * Previously this shelled out to the `sqlite3` CLI, an undeclared system
 * requirement that made `ml:train` fail on a fresh clone without it. The
 * server already depends on better-sqlite3, so use that instead.
 */
function sqliteJsonQuery<T>(dbPath: string, sql: string): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

export function loadAnnotatedMidiFiles(dbPath: string, rootDir: string): AnnotatedMidiFile[] {
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const rows = sqliteJsonQuery<AnnotationSqlRow>(
    dbPath,
    `
      SELECT
        a.file_id,
        a.song_name,
        a.start_time,
        a.end_time,
        f.local_path,
        f.filename
      FROM annotations a
      JOIN files f ON f.id = a.file_id
      ORDER BY a.file_id ASC, a.start_time ASC
    `
  );

  const byFile = new Map<number, AnnotatedMidiFile>();

  for (const row of rows) {
    const fileId = toNum(row.file_id);
    const midiPath = path.resolve(rootDir, row.local_path);
    if (!existsSync(midiPath)) {
      continue;
    }

    if (!byFile.has(fileId)) {
      byFile.set(fileId, {
        fileId,
        filename: row.filename,
        midiPath,
        annotations: []
      });
    }

    byFile.get(fileId)!.annotations.push({
      songName: row.song_name,
      startTime: toNum(row.start_time),
      endTime: toNum(row.end_time)
    });
  }

  const files = [...byFile.values()];
  files.sort((a, b) => a.fileId - b.fileId);
  return files;
}

export function extractNotesFromMidi(midiPath: string): NoteEvent[] {
  const sequence = parseNoteSequence(new Uint8Array(readFileSync(midiPath)));

  // `core` yields absolute start/end times; the feature extractor works in
  // `startSec`/`endSec`, so adapt here rather than in the shared module.
  return sequence.notes.map((note) => ({
    pitch: note.pitch,
    velocity: note.velocity,
    startSec: note.startTime,
    endSec: note.endTime
  }));
}

function buildWindowStarts(maxTime: number, windowSec: number, stepSec: number): number[] {
  if (maxTime <= 0) return [0];

  const maxStart = Math.max(0, maxTime - windowSec);
  const starts: number[] = [];
  for (let t = 0; t <= maxStart + 1e-9; t += stepSec) {
    starts.push(roundTo(t, 6));
  }
  if (starts.length === 0) {
    starts.push(0);
  }

  const last = starts[starts.length - 1];
  if (Math.abs(last - maxStart) > 1e-6) {
    starts.push(roundTo(maxStart, 6));
  }
  return starts;
}

/** Normalized autocorrelation of an onset-density series over candidate lags. */
function onsetRegularity(density: number[]): number {
  const n = density.length;
  let best = 0;
  const maxLag = Math.floor(n / 2);
  for (let lag = 1; lag <= maxLag; lag++) {
    let num = 0;
    let denA = 0;
    let denB = 0;
    for (let i = 0; i < n - lag; i++) {
      num += density[i] * density[i + lag];
      denA += density[i] * density[i];
      denB += density[i + lag] * density[i + lag];
    }
    if (denA > 0 && denB > 0) {
      const r = num / Math.sqrt(denA * denB);
      if (r > best) best = r;
    }
  }
  return best;
}

function extractWindowFeatures(
  notes: NoteEvent[],
  windowStart: number,
  windowSec: number,
  noteCursorHint: number
): { features: number[]; nextCursorHint: number } {
  const windowEnd = windowStart + windowSec;
  const pitchClassDurations = new Array<number>(12).fill(0);

  const polyBins = Math.max(1, Math.ceil(windowSec / POLYPHONY_BIN_SEC));
  const binActiveDur = new Array<number>(polyBins).fill(0);
  const binHasNote = new Array<boolean>(polyBins).fill(false);

  const regBins = Math.max(1, Math.ceil(windowSec / REGULARITY_BIN_SEC));
  const regDensity = new Array<number>(regBins).fill(0);

  let cursor = noteCursorHint;
  while (cursor < notes.length && notes[cursor].endSec <= windowStart) {
    cursor++;
  }

  let onsetCount = 0;
  let onsetPitchSum = 0;
  let onsetPitchSqSum = 0;
  let onsetVelocitySum = 0;
  let onsetVelocitySqSum = 0;
  let onsetDurationSum = 0;
  let onsetDurationSqSum = 0;
  let activeDuration = 0;
  let minPitch = 127;
  let maxPitch = 0;
  let prevOnsetSec = -1;
  const interOnsetIntervals: number[] = [];

  for (let i = cursor; i < notes.length; i++) {
    const note = notes[i];
    if (note.startSec >= windowEnd) break;

    const overlapStart = Math.max(note.startSec, windowStart);
    const overlapEnd = Math.min(note.endSec, windowEnd);
    const overlap = overlapEnd - overlapStart;
    if (overlap > 0) {
      pitchClassDurations[note.pitch % 12] += overlap;
      activeDuration += overlap;

      const bStart = Math.max(0, Math.floor((overlapStart - windowStart) / POLYPHONY_BIN_SEC));
      const bEnd = Math.min(
        polyBins - 1,
        Math.floor((overlapEnd - windowStart - 1e-9) / POLYPHONY_BIN_SEC)
      );
      for (let b = bStart; b <= bEnd; b++) {
        const bSec = windowStart + b * POLYPHONY_BIN_SEC;
        const ovStart = Math.max(overlapStart, bSec);
        const ovEnd = Math.min(overlapEnd, bSec + POLYPHONY_BIN_SEC);
        const ov = Math.max(0, ovEnd - ovStart);
        binActiveDur[b] += ov;
        if (ov > 0) binHasNote[b] = true;
      }
    }

    if (note.startSec >= windowStart && note.startSec < windowEnd) {
      onsetCount++;
      onsetPitchSum += note.pitch;
      onsetPitchSqSum += note.pitch * note.pitch;
      onsetVelocitySum += note.velocity;
      onsetVelocitySqSum += note.velocity * note.velocity;
      const duration = note.endSec - note.startSec;
      onsetDurationSum += duration;
      onsetDurationSqSum += duration * duration;
      if (note.pitch < minPitch) minPitch = note.pitch;
      if (note.pitch > maxPitch) maxPitch = note.pitch;
      if (prevOnsetSec >= 0) {
        const gap = note.startSec - prevOnsetSec;
        if (gap > 0.05 && gap <= 2.5) interOnsetIntervals.push(gap);
      }
      prevOnsetSec = note.startSec;
      const regIdx = Math.min(
        regBins - 1,
        Math.floor((note.startSec - windowStart) / REGULARITY_BIN_SEC)
      );
      regDensity[regIdx]++;
    }
  }

  const totalPcDuration = pitchClassDurations.reduce((sum, v) => sum + v, 0);
  const normalizedPc = totalPcDuration > 0
    ? pitchClassDurations.map((value) => value / totalPcDuration)
    : pitchClassDurations;

  const meanPitch = onsetCount > 0 ? (onsetPitchSum / onsetCount) / 127 : 0;
  const pitchVariance = onsetCount > 0
    ? (onsetPitchSqSum / onsetCount) - ((onsetPitchSum / onsetCount) ** 2)
    : 0;
  const pitchStd = Math.sqrt(Math.max(0, pitchVariance)) / 127;

  const meanVelocity = onsetCount > 0 ? (onsetVelocitySum / onsetCount) / 127 : 0;
  const velocityVariance = onsetCount > 0
    ? (onsetVelocitySqSum / onsetCount) - ((onsetVelocitySum / onsetCount) ** 2)
    : 0;
  const velocityStd = Math.sqrt(Math.max(0, velocityVariance)) / 127;

  const meanDuration = onsetCount > 0 ? clamp((onsetDurationSum / onsetCount) / 6, 0, 1) : 0;
  const durationVariance = onsetCount > 0
    ? (onsetDurationSqSum / onsetCount) - ((onsetDurationSum / onsetCount) ** 2)
    : 0;
  const durationStd = clamp(Math.sqrt(Math.max(0, durationVariance)) / 6, 0, 1);

  const onsetDensity = clamp((onsetCount / windowSec) / 8, 0, 1);
  const meanPolyphony = clamp((activeDuration / windowSec) / 6, 0, 1);

  let polyphonyMean = 0;
  for (const value of binActiveDur) polyphonyMean += value / POLYPHONY_BIN_SEC;
  polyphonyMean /= polyBins;
  let polyphonyVariance = 0;
  for (const value of binActiveDur) {
    const p = value / POLYPHONY_BIN_SEC;
    polyphonyVariance += (p - polyphonyMean) ** 2;
  }
  polyphonyVariance /= polyBins;
  const polyphonyStd = clamp(Math.sqrt(Math.max(0, polyphonyVariance)) / 6, 0, 1);

  let hasNoteBins = 0;
  for (const hasNote of binHasNote) if (hasNote) hasNoteBins++;
  const silenceRatio = 1 - hasNoteBins / polyBins;

  const pitchSpan = onsetCount > 0 ? (maxPitch - minPitch) / 127 : 0;

  let tempoBpm = 0;
  if (interOnsetIntervals.length >= 2) {
    const sorted = [...interOnsetIntervals].sort((a, b) => a - b);
    const medianIoi = sorted[Math.floor(sorted.length / 2)];
    if (medianIoi > 0) tempoBpm = clamp(60 / medianIoi, 20, 240) / 240;
  }

  const regularity = onsetRegularity(regDensity);

  return {
    features: [
      ...normalizedPc,
      onsetDensity,
      meanPitch,
      pitchStd,
      meanVelocity,
      meanDuration,
      meanPolyphony,
      velocityStd,
      durationStd,
      polyphonyStd,
      silenceRatio,
      pitchSpan,
      tempoBpm,
      regularity
    ],
    nextCursorHint: cursor
  };
}

function getLabelAtTime(
  annotations: AnnotationInterval[],
  timeSec: number,
  annotationCursorHint: number
): { label: string; nextCursorHint: number } {
  let cursor = annotationCursorHint;
  while (cursor < annotations.length && timeSec >= annotations[cursor].endTime) {
    cursor++;
  }

  if (
    cursor < annotations.length
    && timeSec >= annotations[cursor].startTime
    && timeSec < annotations[cursor].endTime
  ) {
    return { label: annotations[cursor].songName, nextCursorHint: cursor };
  }

  return { label: NO_SONG_LABEL, nextCursorHint: cursor };
}

export function buildSamplesForFile(
  file: AnnotatedMidiFile,
  notes: NoteEvent[],
  config: Pick<TrainConfig, 'windowSec' | 'stepSec'>
): WindowSample[] {
  const noteMax = notes.length > 0 ? notes[notes.length - 1].endSec : 0;
  const annotationMax = file.annotations.length > 0
    ? file.annotations[file.annotations.length - 1].endTime
    : 0;
  const maxTime = Math.max(noteMax, annotationMax);
  const starts = buildWindowStarts(maxTime, config.windowSec, config.stepSec);

  const windows: WindowSample[] = [];
  let noteCursorHint = 0;
  let annotationCursorHint = 0;

  for (const startTime of starts) {
    const { features, nextCursorHint } = extractWindowFeatures(
      notes,
      startTime,
      config.windowSec,
      noteCursorHint
    );
    noteCursorHint = nextCursorHint;

    const center = startTime + (config.windowSec / 2);
    const labelInfo = getLabelAtTime(file.annotations, center, annotationCursorHint);
    annotationCursorHint = labelInfo.nextCursorHint;

    windows.push({
      fileId: file.fileId,
      fileName: file.filename,
      startTime,
      endTime: startTime + config.windowSec,
      label: labelInfo.label,
      features
    });
  }

  return windows;
}

function evenlySample<T>(items: T[], targetCount: number): T[] {
  if (targetCount >= items.length) return items;
  if (targetCount <= 0) return [];

  const stride = items.length / targetCount;
  const sampled: T[] = [];
  for (let i = 0; i < targetCount; i++) {
    const idx = Math.floor(i * stride);
    sampled.push(items[idx]);
  }
  return sampled;
}

/**
 * Compute per-feature normalization constants. The vectors are `number[][]`
 * of raw features; `mode` decides what `means`/`stds` hold:
 *   'zscore'  means = mean,    stds = population std
 *   'minmax'  means = min,     stds = max - min
 *   'none'    means = 0,       stds = 1
 * In every mode `normalizeVector` computes `(x - means) / stds`, so a single
 * code path works for all three.
 */
function standardize(
  vectors: number[][],
  mode: 'zscore' | 'minmax' | 'none' = 'zscore'
): { means: number[]; stds: number[] } {
  const featureCount = vectors[0]?.length || 0;
  const means = new Array(featureCount).fill(0);
  const stds = new Array(featureCount).fill(1);

  if (mode === 'none') {
    return { means, stds };
  }

  if (mode === 'minmax') {
    const mins = new Array(featureCount).fill(Infinity);
    const maxs = new Array(featureCount).fill(-Infinity);
    for (const vector of vectors) {
      for (let i = 0; i < featureCount; i++) {
        if (vector[i] < mins[i]) mins[i] = vector[i];
        if (vector[i] > maxs[i]) maxs[i] = vector[i];
      }
    }
    for (let i = 0; i < featureCount; i++) {
      const range = maxs[i] - mins[i];
      means[i] = mins[i];
      stds[i] = Number.isFinite(range) && range > 1e-9 ? range : 1;
    }
    return { means, stds };
  }

  for (const vector of vectors) {
    for (let i = 0; i < featureCount; i++) {
      means[i] += vector[i];
    }
  }
  for (let i = 0; i < featureCount; i++) {
    means[i] /= Math.max(1, vectors.length);
  }

  for (const vector of vectors) {
    for (let i = 0; i < featureCount; i++) {
      const diff = vector[i] - means[i];
      stds[i] += diff * diff;
    }
  }
  for (let i = 0; i < featureCount; i++) {
    stds[i] = Math.sqrt(stds[i] / Math.max(1, vectors.length));
    if (!Number.isFinite(stds[i]) || stds[i] < 1e-6) {
      stds[i] = 1;
    }
  }

  return { means, stds };
}

function normalizeVector(vector: number[], means: number[], stds: number[]): number[] {
  return vector.map((value, idx) => (value - means[idx]) / stds[idx]);
}

function squaredDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

/**
 * Allocate a prototype count per label. Budgets scale with sqrt(support) so
 * that frequent songs keep more prototypes without drowning out songs that
 * appear only a few times, then the whole budget is normalized to
 * `prototypeBudget`. The `__none__` class gets a hard cap because its window
 * set is enormous and heterogeneous, and we do not want it to dominate.
 */
function allocatePrototypeBudgets(
  support: Map<number, number>,
  config: TrainConfig
): Map<number, number> {
  const maxTotal = Math.max(1, config.prototypeBudget ?? 1200);
  const maxNone = Math.max(1, config.maxNonePrototypes ?? 120);

  let sumSqrt = 0;
  const sqrts = new Map<number, number>();
  for (const [labelIndex, count] of support) {
    const s = Math.sqrt(count);
    sqrts.set(labelIndex, s);
    sumSqrt += s;
  }

  const budgets = new Map<number, number>();
  for (const [labelIndex, s] of sqrts) {
    let budget = Math.max(1, Math.round(s * (maxTotal / sumSqrt)));
    if (labelIndex === 0) budget = Math.min(budget, maxNone);
    budgets.set(labelIndex, budget);
  }
  return budgets;
}

/**
 * Estimate the exp(-d/sigma) kernel scale from the training distribution: the
 * median distance from a sample to its nearest prototype. A deterministic
 * subsample keeps this cheap for leave-one-out folds.
 */
function estimateKernelScale(
  normalizedGroups: Map<number, number[][]>,
  prototypes: Array<{ features: number[]; labelIndex: number }>,
  sampleCount = 800
): number {
  const all: number[][] = [];
  for (const vectors of normalizedGroups.values()) all.push(...vectors);

  const samples = evenlySample(all, sampleCount);
  if (samples.length === 0) return 1;

  const nearestDistances: number[] = [];
  for (const vector of samples) {
    let best = Infinity;
    for (const prototype of prototypes) {
      const d = squaredDistance(vector, prototype.features);
      if (d < best) best = d;
    }
    nearestDistances.push(best);
  }

  nearestDistances.sort((a, b) => a - b);
  const median = nearestDistances[Math.floor(nearestDistances.length / 2)];
  return Math.max(median, 0.05);
}

function buildPrototypesFromGroups(
  normalizedGroups: Map<number, number[][]>,
  config: TrainConfig
): {
  prototypes: Array<{ features: number[]; labelIndex: number }>;
  prototypeCounts: number[];
  kernelScale: number;
  labelCount: number;
} {
  const labelCount = normalizedGroups.size === 0 ? 0 : Math.max(...normalizedGroups.keys()) + 1;
  const support = new Map<number, number>();
  for (const [labelIndex, vectors] of normalizedGroups) support.set(labelIndex, vectors.length);

  const budgets = allocatePrototypeBudgets(support, config);
  const prototypes: Array<{ features: number[]; labelIndex: number }> = [];
  const prototypeCounts = new Array<number>(labelCount).fill(0);

  for (const [labelIndex, vectors] of normalizedGroups) {
    const budget = Math.min(budgets.get(labelIndex)!, vectors.length);
    const sampled = evenlySample(vectors, budget);
    for (const vector of sampled) {
      prototypes.push({ features: vector, labelIndex });
    }
    prototypeCounts[labelIndex] = sampled.length;
  }

  const kernelScale = estimateKernelScale(normalizedGroups, prototypes);
  return { prototypes, prototypeCounts, kernelScale, labelCount };
}

function fitModelFromSamples(
  samples: WindowSample[],
  config: TrainConfig,
  trainingSummaryOverride?: Partial<SongSegmentModel['trainingSummary']>
): SongSegmentModel {
  if (samples.length === 0) {
    throw new Error('No training samples produced. Add annotations first.');
  }

  const positive = samples.filter((sample) => sample.label !== NO_SONG_LABEL);
  const negative = samples.filter((sample) => sample.label === NO_SONG_LABEL);
  const maxNone = Math.max(1, Math.floor(positive.length * config.maxNoneToSongRatio));
  const keptNegative = evenlySample(negative, maxNone);
  const kept = [...positive, ...keptNegative];

  const labels = [...new Set(kept.map((sample) => sample.label))].sort((a, b) => {
    if (a === NO_SONG_LABEL) return -1;
    if (b === NO_SONG_LABEL) return 1;
    return a.localeCompare(b);
  });
  const labelToIndex = new Map(labels.map((label, idx) => [label, idx]));

  const rawVectors = kept.map((sample) => sample.features);
  const scalingMode = config.featureScaling ?? 'minmax';
  const { means, stds } = standardize(rawVectors, scalingMode);

  const normalizedGroups = new Map<number, number[][]>();
  for (const sample of kept) {
    const labelIndex = labelToIndex.get(sample.label)!;
    let group = normalizedGroups.get(labelIndex);
    if (!group) {
      group = [];
      normalizedGroups.set(labelIndex, group);
    }
    group.push(normalizeVector(sample.features, means, stds));
  }

  const { prototypes, prototypeCounts, kernelScale } = buildPrototypesFromGroups(
    normalizedGroups,
    config
  );

  const labelCounts: Record<string, number> = {};
  for (const sample of kept) {
    labelCounts[sample.label] = (labelCounts[sample.label] || 0) + 1;
  }

  const distinctFiles = new Set(kept.map((sample) => sample.fileId));
  const model: SongSegmentModel = {
    modelType: 'knn-song-segmenter',
    version: 2,
    createdAt: new Date().toISOString(),
    config,
    featureNames: [...FEATURE_NAMES],
    labels,
    featureMeans: means,
    featureStds: stds,
    prototypes,
    prototypeCounts,
    kernelScale,
    trainingSummary: {
      filesUsed: distinctFiles.size,
      annotationsUsed: trainingSummaryOverride?.annotationsUsed ?? 0,
      totalSamples: kept.length,
      positiveSamples: positive.length,
      noneSamples: keptNegative.length,
      labelCounts,
      ...trainingSummaryOverride
    }
  };

  return model;
}

export function trainModelFromSamples(
  samples: WindowSample[],
  config: TrainConfig
): SongSegmentModel {
  return fitModelFromSamples(samples, config);
}

/** Classic k-NN over the raw training vectors (v1 models only). */
function computeKnnScores(normalizedVector: number[], model: SongSegmentModel): number[] {
  const vectors = model.trainingVectors!;
  const labels = model.trainingLabelIndices!;
  const total = vectors.length;
  const k = Math.max(1, Math.min(model.config.k, total));
  const distances = new Array<{ idx: number; distance: number }>(total);

  for (let i = 0; i < total; i++) {
    distances[i] = {
      idx: i,
      distance: squaredDistance(normalizedVector, vectors[i])
    };
  }
  distances.sort((a, b) => a.distance - b.distance);

  const scores = new Array<number>(model.labels.length).fill(0);
  for (let i = 0; i < k; i++) {
    const row = distances[i];
    const weight = 1 / (Math.sqrt(row.distance) + 1e-6);
    scores[labels[row.idx]] += weight;
  }
  return scores;
}

/** v2: per-label score from that label's prototypes. */
function computePrototypeScores(normalizedVector: number[], model: SongSegmentModel): number[] {
  const scores = new Array<number>(model.labels.length).fill(0);
  const count = new Array<number>(model.labels.length).fill(0);
  const minDist = new Array<number>(model.labels.length).fill(Infinity);

  if (model.config.scoreMode === 'avg') {
    const kernelScale = model.kernelScale ?? 1;
    for (const prototype of model.prototypes!) {
      const d = squaredDistance(normalizedVector, prototype.features);
      scores[prototype.labelIndex] += Math.exp(-d / kernelScale);
      count[prototype.labelIndex]++;
    }
    for (let labelIndex = 0; labelIndex < model.labels.length; labelIndex++) {
      if (count[labelIndex] > 0) scores[labelIndex] /= count[labelIndex];
    }
    return scores;
  }

  // 'min' mode: score by closeness of the nearest prototype per label. Using
  // negative distance keeps the direction "higher is better" for the softmax,
  // and dividing by prototype count is unnecessary because the min is not
  // sensitive to how many prototypes a label has.
  for (const prototype of model.prototypes!) {
    const d = squaredDistance(normalizedVector, prototype.features);
    if (d < minDist[prototype.labelIndex]) minDist[prototype.labelIndex] = d;
  }
  for (let labelIndex = 0; labelIndex < model.labels.length; labelIndex++) {
    scores[labelIndex] = Number.isFinite(minDist[labelIndex]) ? -Math.sqrt(minDist[labelIndex]) : -Infinity;
  }
  return scores;
}

function computeLabelScores(normalizedVector: number[], model: SongSegmentModel): number[] {
  if (model.prototypes && model.prototypes.length > 0) {
    return computePrototypeScores(normalizedVector, model);
  }
  return computeKnnScores(normalizedVector, model);
}

function predictLabelIndex(
  normalizedVector: number[],
  model: SongSegmentModel
): { labelIndex: number; confidence: number } {
  const scores = computeLabelScores(normalizedVector, model);
  let bestLabel = 0;
  for (let labelIndex = 1; labelIndex < scores.length; labelIndex++) {
    if (scores[labelIndex] > scores[bestLabel]) bestLabel = labelIndex;
  }

  let totalScore = 0;
  for (const score of scores) totalScore += Math.max(0, score);
  const confidence = totalScore > 0 ? Math.max(0, scores[bestLabel]) / totalScore : 0;
  return { labelIndex: bestLabel, confidence };
}

function scoresToLogProbs(scores: number[], temperature: number): number[] {
  let maxScore = -Infinity;
  for (const score of scores) if (score > maxScore) maxScore = score;

  const shifted = scores.map((score) => (score - maxScore) / Math.max(1e-9, temperature));
  let sumExp = 0;
  for (const value of shifted) sumExp += Math.exp(value);
  const logZ = Math.log(Math.max(1e-9, sumExp));
  return shifted.map((value) => value - logZ);
}

/**
 * Viterbi decode over per-window log-probabilities with a single label-change
 * penalty. Enforces that songs occupy contiguous runs of windows, which is the
 * structure the annotations actually have.
 */
function decodeViterbi(emissions: number[][], changePenalty: number): number[] {
  const windowCount = emissions.length;
  if (windowCount === 0) return [];
  const labelCount = emissions[0].length;

  let dp = emissions[0].slice();
  const backPointers = new Array<Int32Array>(windowCount);
  backPointers[0] = new Int32Array(labelCount).fill(-1);

  for (let t = 1; t < windowCount; t++) {
    let top1 = -Infinity;
    let top2 = -Infinity;
    let arg1 = -1;
    let arg2 = -1;
    for (let labelIndex = 0; labelIndex < labelCount; labelIndex++) {
      const value = dp[labelIndex];
      if (value > top1) {
        top2 = top1;
        arg2 = arg1;
        top1 = value;
        arg1 = labelIndex;
      } else if (value > top2) {
        top2 = value;
        arg2 = labelIndex;
      }
    }

    const current = new Array<number>(labelCount);
    const back = new Int32Array(labelCount);
    const emission = emissions[t];
    for (let labelIndex = 0; labelIndex < labelCount; labelIndex++) {
      const stay = dp[labelIndex];
      const bestOther = (labelIndex === arg1 ? top2 : top1) - changePenalty;
      if (stay >= bestOther) {
        current[labelIndex] = emission[labelIndex] + stay;
        back[labelIndex] = labelIndex;
      } else {
        current[labelIndex] = emission[labelIndex] + bestOther;
        back[labelIndex] = labelIndex === arg1 ? arg2 : arg1;
      }
    }
    dp = current;
    backPointers[t] = back;
  }

  let bestLabel = 0;
  for (let labelIndex = 1; labelIndex < labelCount; labelIndex++) {
    if (dp[labelIndex] > dp[bestLabel]) bestLabel = labelIndex;
  }

  const path = new Array<number>(windowCount);
  path[windowCount - 1] = bestLabel;
  for (let t = windowCount - 1; t > 0; t--) {
    path[t - 1] = backPointers[t][path[t]];
  }
  return path;
}

interface WindowEvidence {
  scores: number[];
  bestLabel: number;
  /** Mode-agnostic margin: (top1 - top2) / (|top1| + |top2|) in score space. */
  margin: number;
  /** rank[label] = position of label in descending score order (0 = best). */
  rank: number[];
}

function computeEvidence(scoresList: number[][]): WindowEvidence[] {
  return scoresList.map((scores) => {
    let top1 = -Infinity;
    let top2 = -Infinity;
    let bestLabel = 0;
    for (let labelIndex = 0; labelIndex < scores.length; labelIndex++) {
      const value = scores[labelIndex];
      if (value > top1) {
        top2 = top1;
        top1 = value;
        bestLabel = labelIndex;
      } else if (value > top2) {
        top2 = value;
      }
    }
    const scale = Math.abs(top1) + Math.abs(top2);
    const margin = scale > 1e-9 ? (top1 - top2) / scale : 0;

    const order = scores
      .map((score, labelIndex) => ({ score, labelIndex }))
      .sort((a, b) => b.score - a.score);
    const rank = new Array<number>(scores.length).fill(0);
    order.forEach((entry, position) => { rank[entry.labelIndex] = position; });

    return { scores, bestLabel, margin, rank };
  });
}

/**
 * Two-pass "anchor and link" decoder.
 *
 * Pass 1 finds recognizable anchor runs: consecutive windows whose top label
 * beats the runner-up by a wide margin. These are the phrases of a song that
 * are easy to identify. Pass 2 links those anchors together by extending each
 * run across intervening windows whose evidence is weak or ambiguous -- the
 * generic vamping, left-hand-only, or warm-up passages that sit between the
 * recognizable moments. Extension stops at a strong anchor of a different
 * song (a real transition) or a strong `__none__` anchor (genuine silence).
 */
function anchorLinkDecode(
  evidence: WindowEvidence[],
  config: TrainConfig,
  noneLabelIndex: number
): { labels: number[]; confidence: number[] } {
  const n = evidence.length;
  const labels = new Array<number>(n).fill(-1);
  const confidence = new Array<number>(n).fill(0);

  const anchorMargin = config.anchorMargin ?? 0.15;
  const minAnchorRun = Math.max(1, config.minAnchorRun ?? 3);
  const fillMinMargin = config.fillMinMargin ?? 0;
  const fillTopK = config.fillTopK ?? -1;
  const linkConfidence = config.linkConfidence ?? 0.5;

  const isAnchor = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const e = evidence[i];
    if (e.bestLabel !== noneLabelIndex && e.margin >= anchorMargin) {
      isAnchor[i] = true;
    }
  }

  const canFill = (i: number, label: number): boolean => {
    if (labels[i] !== -1) return false;
    const e = evidence[i];
    if (e.bestLabel === label) return true;
    if (e.margin >= anchorMargin) return false;
    if (e.margin < fillMinMargin) return false;
    if (fillTopK >= 0 && e.rank[label] >= fillTopK) return false;
    return true;
  };

  // Pass 1: seed runs of consecutive same-label anchors. The confidence a run
  // passes on to its linked windows is its average anchor margin, so linked
  // (vamping) passages carry the strength of the anchors that surround them.
  for (let i = 0; i < n; ) {
    if (!isAnchor[i]) {
      i++;
      continue;
    }
    const label = evidence[i].bestLabel;
    let j = i;
    let marginSum = 0;
    while (j < n && isAnchor[j] && evidence[j].bestLabel === label) {
      marginSum += evidence[j].margin;
      j++;
    }
    if (j - i >= minAnchorRun) {
      const runMargin = marginSum / (j - i);
      const fillConf = Math.max(linkConfidence, runMargin * 0.85);
      for (let k = i; k < j; k++) {
        labels[k] = label;
        confidence[k] = evidence[k].margin;
      }
      // Extend this run to the right.
      for (let k = j; k < n; k++) {
        if (labels[k] !== -1) break;
        if (!canFill(k, label)) break;
        labels[k] = label;
        confidence[k] = fillConf;
      }
      // Extend this run to the left.
      for (let k = i - 1; k >= 0; k--) {
        if (labels[k] !== -1) break;
        if (!canFill(k, label)) break;
        labels[k] = label;
        confidence[k] = fillConf;
      }
    }
    i = j;
  }

  for (let i = 0; i < n; i++) {
    if (labels[i] === -1) labels[i] = noneLabelIndex;
  }

  return { labels, confidence };
}

export function trainModel(
  files: AnnotatedMidiFile[],
  config: TrainConfig
): { model: SongSegmentModel; samplesByFile: Map<number, WindowSample[]> } {
  const samplesByFile = new Map<number, WindowSample[]>();
  const allSamples: WindowSample[] = [];
  let annotationsUsed = 0;

  for (const file of files) {
    const notes = extractNotesFromMidi(file.midiPath);
    const windows = buildSamplesForFile(file, notes, config);
    samplesByFile.set(file.fileId, windows);
    allSamples.push(...windows);
    annotationsUsed += file.annotations.length;
  }

  const model = fitModelFromSamples(allSamples, config, {
    filesUsed: files.length,
    annotationsUsed
  });

  return { model, samplesByFile };
}

export function evaluateLeaveOneOut(
  files: AnnotatedMidiFile[],
  config: TrainConfig,
  samplesByFile?: Map<number, WindowSample[]>
): LeaveOneOutEvaluation {
  const windowsByFile = samplesByFile || new Map<number, WindowSample[]>();
  if (!samplesByFile) {
    for (const file of files) {
      const notes = extractNotesFromMidi(file.midiPath);
      windowsByFile.set(file.fileId, buildSamplesForFile(file, notes, config));
    }
  }

  const folds: LeaveOneOutFold[] = [];

  for (const testFile of files) {
    const trainSamples: WindowSample[] = [];
    const testSamples = windowsByFile.get(testFile.fileId) || [];

    for (const file of files) {
      if (file.fileId === testFile.fileId) continue;
      trainSamples.push(...(windowsByFile.get(file.fileId) || []));
    }

    if (trainSamples.length === 0 || testSamples.length === 0) {
      continue;
    }

    const foldModel = fitModelFromSamples(trainSamples, config);
    let totalCorrect = 0;
    let songTotal = 0;
    let songCorrect = 0;

    for (const sample of testSamples) {
      const normalized = normalizeVector(sample.features, foldModel.featureMeans, foldModel.featureStds);
      const pred = predictLabelIndex(normalized, foldModel);
      const predictedLabel = foldModel.labels[pred.labelIndex];

      if (predictedLabel === sample.label) {
        totalCorrect++;
      }
      if (sample.label !== NO_SONG_LABEL) {
        songTotal++;
        if (predictedLabel === sample.label) {
          songCorrect++;
        }
      }
    }

    folds.push({
      fileId: testFile.fileId,
      filename: testFile.filename,
      totalWindows: testSamples.length,
      overallAccuracy: totalCorrect / testSamples.length,
      songWindows: songTotal,
      songAccuracy: songTotal > 0 ? songCorrect / songTotal : 0
    });
  }

  if (folds.length === 0) {
    return {
      folds: [],
      meanOverallAccuracy: 0,
      meanSongAccuracy: 0
    };
  }

  const meanOverallAccuracy = folds.reduce((sum, fold) => sum + fold.overallAccuracy, 0) / folds.length;
  const meanSongAccuracy = folds.reduce((sum, fold) => sum + fold.songAccuracy, 0) / folds.length;

  return {
    folds,
    meanOverallAccuracy,
    meanSongAccuracy
  };
}

export function saveModel(model: SongSegmentModel, outPath: string) {
  ensureDirForFile(outPath);
  writeFileSync(outPath, JSON.stringify(model, null, 2), 'utf8');
}

export function loadModel(modelPath: string): SongSegmentModel {
  const raw = readFileSync(modelPath, 'utf8');
  const parsed = JSON.parse(raw) as SongSegmentModel;

  if (parsed.modelType !== 'knn-song-segmenter') {
    throw new Error(`Unsupported model type: ${String((parsed as any).modelType)}`);
  }
  const hasPrototypes = Array.isArray(parsed.prototypes) && parsed.prototypes.length > 0;
  const hasVectors = Array.isArray(parsed.trainingVectors) && parsed.trainingVectors.length > 0;
  if (!hasPrototypes && !hasVectors) {
    throw new Error('Model has no training vectors or prototypes.');
  }
  return parsed;
}

function buildUnlabeledWindows(notes: NoteEvent[], config: Pick<TrainConfig, 'windowSec' | 'stepSec'>): WindowSample[] {
  const noteMax = notes.length > 0 ? notes[notes.length - 1].endSec : 0;
  const starts = buildWindowStarts(noteMax, config.windowSec, config.stepSec);

  const windows: WindowSample[] = [];
  let noteCursorHint = 0;
  for (const startTime of starts) {
    const featureInfo = extractWindowFeatures(notes, startTime, config.windowSec, noteCursorHint);
    noteCursorHint = featureInfo.nextCursorHint;
    windows.push({
      fileId: -1,
      fileName: '',
      startTime,
      endTime: startTime + config.windowSec,
      label: NO_SONG_LABEL,
      features: featureInfo.features
    });
  }
  return windows;
}

export function predictWindows(
  model: SongSegmentModel,
  midiPath: string,
  options: PredictConfig
): WindowPrediction[] {
  const notes = extractNotesFromMidi(midiPath);
  const windows = buildUnlabeledWindows(notes, model.config);
  return predictWindowsFromSamples(model, windows, options);
}

export function predictWindowsFromSamples(
  model: SongSegmentModel,
  windows: Pick<WindowSample, 'startTime' | 'endTime' | 'features'>[],
  options: Pick<PredictConfig, 'minWindowConfidence' | 'smoothingWindows'>
): WindowPrediction[] {
  const windowCount = windows.length;
  if (windowCount === 0) return [];

  const decoder = model.config.decoder ?? 'anchor';
  const temperature = model.config.temperature ?? 1;

  const scoresList = new Array<number[]>(windowCount);
  for (let i = 0; i < windowCount; i++) {
    const normalized = normalizeVector(windows[i].features, model.featureMeans, model.featureStds);
    scoresList[i] = computeLabelScores(normalized, model);
  }

  if (decoder === 'anchor') {
    const noneLabelIndex = model.labels.indexOf(NO_SONG_LABEL);
    const evidence = computeEvidence(scoresList);
    const { labels, confidence } = anchorLinkDecode(evidence, model.config, noneLabelIndex);
    const predictions: WindowPrediction[] = [];
    for (let i = 0; i < windowCount; i++) {
      predictions.push({
        startTime: windows[i].startTime,
        endTime: windows[i].endTime,
        label: model.labels[labels[i]],
        confidence: confidence[i]
      });
    }
    return predictions;
  }

  const changePenalty = model.config.viterbiChangePenalty ?? 1;
  const emissions = scoresList.map((scores) => scoresToLogProbs(scores, temperature));

  let finalLabels: number[];
  let finalConfidence: number[];
  if (decoder === 'viterbi') {
    const path = decodeViterbi(emissions, changePenalty);
    finalLabels = path;
    finalConfidence = path.map((labelIndex, i) => Math.exp(emissions[i][labelIndex]));
  } else {
    finalLabels = emissions.map((emission) => {
      let best = 0;
      for (let labelIndex = 1; labelIndex < emission.length; labelIndex++) {
        if (emission[labelIndex] > emission[best]) best = labelIndex;
      }
      return best;
    });
    finalConfidence = finalLabels.map((labelIndex, i) => Math.exp(emissions[i][labelIndex]));
  }

  const predictions: WindowPrediction[] = [];
  for (let i = 0; i < windowCount; i++) {
    let label = model.labels[finalLabels[i]];
    if (finalConfidence[i] < options.minWindowConfidence) {
      label = NO_SONG_LABEL;
    }
    predictions.push({
      startTime: windows[i].startTime,
      endTime: windows[i].endTime,
      label,
      confidence: finalConfidence[i]
    });
  }

  if (decoder === 'viterbi') {
    return predictions;
  }
  return smoothWindowPredictions(predictions, options.smoothingWindows);
}

export function smoothWindowPredictions(
  windows: WindowPrediction[],
  smoothingWindows: number
): WindowPrediction[] {
  if (smoothingWindows <= 1 || windows.length <= 1) {
    return [...windows];
  }

  const radius = Math.floor(smoothingWindows / 2);
  const smoothed: WindowPrediction[] = [];

  for (let i = 0; i < windows.length; i++) {
    const start = Math.max(0, i - radius);
    const end = Math.min(windows.length - 1, i + radius);
    const voteScores = new Map<string, number>();
    let totalScore = 0;

    for (let j = start; j <= end; j++) {
      const label = windows[j].label;
      const score = windows[j].confidence;
      voteScores.set(label, (voteScores.get(label) || 0) + score);
      totalScore += score;
    }

    let bestLabel = windows[i].label;
    let bestScore = -1;
    for (const [label, score] of voteScores.entries()) {
      if (score > bestScore) {
        bestLabel = label;
        bestScore = score;
      }
    }

    smoothed.push({
      startTime: windows[i].startTime,
      endTime: windows[i].endTime,
      label: bestLabel,
      confidence: totalScore > 0 ? bestScore / totalScore : windows[i].confidence
    });
  }

  return smoothed;
}

export function windowsToSegments(
  windows: WindowPrediction[],
  options: Pick<PredictConfig, 'minSegmentSec' | 'minSegmentConfidence' | 'mergeGapSec'>
): SongSegment[] {
  const provisional: SongSegment[] = [];

  let currentLabel = '';
  let currentStart = 0;
  let currentEnd = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;

  const flush = () => {
    if (!currentLabel || currentLabel === NO_SONG_LABEL) return;
    const durationSec = currentEnd - currentStart;
    provisional.push({
      songName: currentLabel,
      startTime: currentStart,
      endTime: currentEnd,
      durationSec,
      confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : 0
    });
  };

  for (const window of windows) {
    if (currentLabel === '') {
      currentLabel = window.label;
      currentStart = window.startTime;
      currentEnd = window.endTime;
      confidenceSum = window.confidence;
      confidenceCount = 1;
      continue;
    }

    if (window.label === currentLabel) {
      currentEnd = window.endTime;
      confidenceSum += window.confidence;
      confidenceCount++;
      continue;
    }

    flush();
    currentLabel = window.label;
    currentStart = window.startTime;
    currentEnd = window.endTime;
    confidenceSum = window.confidence;
    confidenceCount = 1;
  }
  flush();

  const filtered = provisional.filter(
    (segment) =>
      segment.durationSec >= options.minSegmentSec
      && segment.confidence >= options.minSegmentConfidence
  );
  if (filtered.length <= 1) {
    return filtered.map((segment) => ({
      ...segment,
      startTime: roundTo(segment.startTime),
      endTime: roundTo(segment.endTime),
      durationSec: roundTo(segment.durationSec),
      confidence: roundTo(segment.confidence)
    }));
  }

  const merged: SongSegment[] = [];
  for (const segment of filtered) {
    const last = merged[merged.length - 1];
    if (
      last
      && last.songName === segment.songName
      && segment.startTime - last.endTime <= options.mergeGapSec
    ) {
      const combinedDuration = (last.endTime - last.startTime) + (segment.endTime - segment.startTime);
      const weightedConfidence = (
        (last.confidence * (last.endTime - last.startTime))
        + (segment.confidence * (segment.endTime - segment.startTime))
      ) / Math.max(1e-9, combinedDuration);

      last.endTime = segment.endTime;
      last.durationSec = last.endTime - last.startTime;
      last.confidence = weightedConfidence;
    } else {
      merged.push({ ...segment });
    }
  }

  return merged.map((segment) => ({
    ...segment,
    startTime: roundTo(segment.startTime),
    endTime: roundTo(segment.endTime),
    durationSec: roundTo(segment.durationSec),
    confidence: roundTo(segment.confidence)
  }));
}