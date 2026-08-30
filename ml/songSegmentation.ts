import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as toneMidiPkg from '@tonejs/midi';
import { normalizeJamcorderTempoMap } from '../lib/midiTempoNormalization';

export const NO_SONG_LABEL = '__none__';

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
  'mean_polyphony'
] as const;

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
  k: number;
  maxNoneToSongRatio: number;
}

export interface SongSegmentModel {
  modelType: 'knn-song-segmenter';
  version: 1;
  createdAt: string;
  config: TrainConfig;
  featureNames: string[];
  labels: string[];
  featureMeans: number[];
  featureStds: number[];
  trainingVectors: number[][];
  trainingLabelIndices: number[];
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

const Midi = (
  (toneMidiPkg as any).Midi
  ?? (toneMidiPkg as any).default?.Midi
  ?? (toneMidiPkg as any).default
);

function toNum(value: unknown): number {
  if (typeof value === 'number') return value;
  return Number(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ensureDirForFile(filePath: string) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function sqliteJsonQuery<T>(dbPath: string, sql: string): T[] {
  const stdout = execFileSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf8'
  }).trim();

  if (!stdout) return [];
  return JSON.parse(stdout) as T[];
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
  const notes: NoteEvent[] = [];
  const rawBytes = new Uint8Array(readFileSync(midiPath));
  const normalizedBytes = normalizeJamcorderTempoMap(rawBytes);
  const parsedMidi = new Midi(normalizedBytes);

  for (const track of parsedMidi.tracks) {
    for (const note of track.notes) {
      const startSec = toNum(note.time);
      const durationSec = toNum(note.duration);
      const endSec = startSec + durationSec;
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
        continue;
      }

      notes.push({
        pitch: toNum(note.midi),
        velocity: Math.round(clamp(toNum(note.velocity), 0, 1) * 127),
        startSec,
        endSec
      });
    }
  }

  notes.sort((a, b) => (a.startSec - b.startSec) || (a.pitch - b.pitch));
  return notes;
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

function extractWindowFeatures(
  notes: NoteEvent[],
  windowStart: number,
  windowSec: number,
  noteCursorHint: number
): { features: number[]; nextCursorHint: number } {
  const windowEnd = windowStart + windowSec;
  const pitchClassDurations = new Array<number>(12).fill(0);
  let cursor = noteCursorHint;

  while (cursor < notes.length && notes[cursor].endSec <= windowStart) {
    cursor++;
  }

  let onsetCount = 0;
  let onsetPitchSum = 0;
  let onsetPitchSqSum = 0;
  let onsetVelocitySum = 0;
  let onsetDurationSum = 0;
  let activeDuration = 0;

  for (let i = cursor; i < notes.length; i++) {
    const note = notes[i];
    if (note.startSec >= windowEnd) break;

    const overlapStart = Math.max(note.startSec, windowStart);
    const overlapEnd = Math.min(note.endSec, windowEnd);
    const overlap = overlapEnd - overlapStart;
    if (overlap > 0) {
      pitchClassDurations[note.pitch % 12] += overlap;
      activeDuration += overlap;
    }

    if (note.startSec >= windowStart && note.startSec < windowEnd) {
      onsetCount++;
      onsetPitchSum += note.pitch;
      onsetPitchSqSum += note.pitch * note.pitch;
      onsetVelocitySum += note.velocity;
      onsetDurationSum += note.endSec - note.startSec;
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
  const onsetDensity = clamp((onsetCount / windowSec) / 8, 0, 1);
  const meanDuration = onsetCount > 0 ? clamp((onsetDurationSum / onsetCount) / 6, 0, 1) : 0;
  const meanPolyphony = clamp((activeDuration / windowSec) / 6, 0, 1);

  return {
    features: [
      ...normalizedPc,
      onsetDensity,
      meanPitch,
      pitchStd,
      meanVelocity,
      meanDuration,
      meanPolyphony
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

function standardize(vectors: number[][]): { means: number[]; stds: number[] } {
  const featureCount = vectors[0]?.length || 0;
  const means = new Array(featureCount).fill(0);
  const stds = new Array(featureCount).fill(1);

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
  const { means, stds } = standardize(rawVectors);
  const trainingVectors = rawVectors.map((vector) => normalizeVector(vector, means, stds));
  const trainingLabelIndices = kept.map((sample) => labelToIndex.get(sample.label)!);

  const labelCounts: Record<string, number> = {};
  for (const sample of kept) {
    labelCounts[sample.label] = (labelCounts[sample.label] || 0) + 1;
  }

  const distinctFiles = new Set(kept.map((sample) => sample.fileId));
  const model: SongSegmentModel = {
    modelType: 'knn-song-segmenter',
    version: 1,
    createdAt: new Date().toISOString(),
    config,
    featureNames: [...FEATURE_NAMES],
    labels,
    featureMeans: means,
    featureStds: stds,
    trainingVectors,
    trainingLabelIndices,
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

function predictLabelIndex(
  normalizedVector: number[],
  model: SongSegmentModel
): { labelIndex: number; confidence: number } {
  const total = model.trainingVectors.length;
  const k = Math.max(1, Math.min(model.config.k, total));
  const distances = new Array<{ idx: number; distance: number }>(total);

  for (let i = 0; i < total; i++) {
    distances[i] = {
      idx: i,
      distance: squaredDistance(normalizedVector, model.trainingVectors[i])
    };
  }
  distances.sort((a, b) => a.distance - b.distance);

  const scores = new Map<number, number>();
  let totalScore = 0;
  for (let i = 0; i < k; i++) {
    const row = distances[i];
    const labelIndex = model.trainingLabelIndices[row.idx];
    const weight = 1 / (Math.sqrt(row.distance) + 1e-6);
    scores.set(labelIndex, (scores.get(labelIndex) || 0) + weight);
    totalScore += weight;
  }

  let bestLabel = model.trainingLabelIndices[distances[0].idx];
  let bestScore = -1;
  for (const [labelIndex, score] of scores.entries()) {
    if (score > bestScore) {
      bestLabel = labelIndex;
      bestScore = score;
    }
  }

  const confidence = totalScore > 0 ? bestScore / totalScore : 0;
  return { labelIndex: bestLabel, confidence };
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
  if (!Array.isArray(parsed.trainingVectors) || parsed.trainingVectors.length === 0) {
    throw new Error('Model has no training vectors.');
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
  const predictions: WindowPrediction[] = [];

  for (const window of windows) {
    const normalized = normalizeVector(window.features, model.featureMeans, model.featureStds);
    const pred = predictLabelIndex(normalized, model);
    let label = model.labels[pred.labelIndex];
    if (pred.confidence < options.minWindowConfidence) {
      label = NO_SONG_LABEL;
    }

    predictions.push({
      startTime: window.startTime,
      endTime: window.endTime,
      label,
      confidence: pred.confidence
    });
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
