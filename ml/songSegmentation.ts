/**
 * Song segmentation: the public surface.
 *
 * The implementation lives in `ml/segmentation/`:
 *   types.ts     shapes and tuning constants
 *   config.ts    training defaults and config resolution
 *   dataset.ts   loading annotated recordings and their notes
 *   vectors.ts   feature-vector maths
 *   features.ts  recording -> labeled feature windows
 *   model.ts     fitting, saving and loading a prototype model
 *   decode.ts    scoring windows and joining them into segments
 *
 * What remains here is the orchestration that spans them: training over a set
 * of files, leave-one-out evaluation, and the prediction entry points.
 */
import { roundTo } from '@core/cli/args';
import { createNearestPrototypeScorer } from './prototypeScorer';
import {
  NO_SONG_LABEL,
  type AnnotatedMidiFile,
  type LeaveOneOutEvaluation,
  type LeaveOneOutFold,
  type PredictConfig,
  type SongRangeSuggestion,
  type SongSegmentModel,
  type TrainConfig,
  type WindowPrediction,
  type WindowSample
} from './segmentation/types';
import { extractNotesFromMidi } from './segmentation/dataset';
import { normalizeVector } from './segmentation/vectors';
import {
  buildSamplesForFile,
  buildUnlabeledWindows,
  extractWindowFeatures
} from './segmentation/features';
import { fitModelFromSamples } from './segmentation/model';
import { computeLabelScores, decodeWindowScores } from './segmentation/decode';

export * from './segmentation/types';
export * from './segmentation/config';
export * from './segmentation/dataset';
export * from './segmentation/vectors';
export * from './segmentation/features';
export * from './segmentation/model';
export * from './segmentation/decode';

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

    // Measure the decoder that the app uses. This code used a per-window
    // argmax before. That path has no anchor seeding, no linking, and no
    // `__none__` handling, so `ml:train` and `rebuild-model` reported an
    // accuracy for a path that no caller runs, and disagreed with `ml:eval`.
    const predictions = predictWindowsFromSamples(foldModel, testSamples, {
      minWindowConfidence: 0,
      smoothingWindows: 1
    });

    for (let i = 0; i < testSamples.length; i++) {
      const sample = testSamples[i];
      const predictedLabel = predictions[i]?.label ?? NO_SONG_LABEL;

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
  return decodeWindowScores(model, windows, scoreWindowsFromSamples(model, windows), options);
}

/** Expensive stage, independent of decoder and segment-filter settings. */
export function scoreWindowsFromSamples(
  model: SongSegmentModel,
  windows: Pick<WindowSample, 'features'>[]
): number[][] {
  const score = model.prototypes?.length && model.config.scoreMode !== 'avg'
    && Math.max(1, model.scoreNeighbors ?? 1) === 1
    ? createNearestPrototypeScorer(model.prototypes, model.labels.length)
    : (vector: number[]) => computeLabelScores(vector, model);
  return windows.map((window) => score(
    normalizeVector(window.features, model.featureMeans, model.featureStds)
  ));
}

/** Cheap stage: the scores must come from this model and these windows, in order. */

function rangeWindowStarts(
  startTime: number,
  endTime: number,
  windowSec: number,
  stepSec: number
): number[] {
  const maxStart = endTime - windowSec;
  if (maxStart <= startTime) {
    // The range is shorter than one window: center a single window on it.
    return [roundTo(Math.max(0, (startTime + endTime) / 2 - windowSec / 2), 6)];
  }

  const starts: number[] = [];
  for (let t = startTime; t <= maxStart + 1e-9; t += stepSec) {
    starts.push(roundTo(t, 6));
  }
  const last = starts[starts.length - 1];
  if (Math.abs(last - maxStart) > 1e-6) {
    starts.push(roundTo(maxStart, 6));
  }
  return starts;
}

/**
 * Rank songs for a time range in one MIDI file, for annotate-time
 * suggestions.
 *
 * Runs the raw classifier over windows covering `[startTime, endTime]`, then
 * aggregates each window's margin (top-label evidence strength) by song. The
 * result is the share of confident evidence each song received. A segment
 * that clearly matches one song comes back with a single high-confidence
 * suggestion. Ambiguous or new material spreads the evidence thin and usually
 * falls below `minConfidence`.
 */
export function suggestSongsForRange(
  model: SongSegmentModel,
  midiPath: string,
  startTime: number,
  endTime: number,
  options: { minConfidence?: number; topK?: number } = {}
): SongRangeSuggestion[] {
  if (!(endTime > startTime)) return [];

  const notes = extractNotesFromMidi(midiPath);
  const windowSec = model.config.windowSec;
  const stepSec = model.config.stepSec;
  const starts = rangeWindowStarts(startTime, endTime, windowSec, stepSec);
  if (starts.length === 0) return [];

  const minConfidence = options.minConfidence ?? 0.3;
  const topK = options.topK ?? 4;
  const evidenceByLabel = new Array<number>(model.labels.length).fill(0);
  let totalEvidence = 0;
  let noteCursor = 0;

  for (const start of starts) {
    const featureInfo = extractWindowFeatures(
      notes,
      start,
      windowSec,
      noteCursor,
      model.config.registerDivide ?? 60
    );
    noteCursor = featureInfo.nextCursorHint;
    const normalized = normalizeVector(featureInfo.features, model.featureMeans, model.featureStds);
    const scores = computeLabelScores(normalized, model);

    let top1 = -Infinity;
    let top2 = -Infinity;
    let top1Label = 0;
    for (let labelIndex = 0; labelIndex < scores.length; labelIndex++) {
      const value = scores[labelIndex];
      if (value > top1) {
        top2 = top1;
        top1 = value;
        top1Label = labelIndex;
      } else if (value > top2) {
        top2 = value;
      }
    }
    const scale = Math.abs(top1) + Math.abs(top2);
    const margin = scale > 1e-9 ? (top1 - top2) / scale : 0;
    evidenceByLabel[top1Label] += margin;
    totalEvidence += margin;
  }

  if (totalEvidence <= 1e-9) return [];

  return model.labels
    .map((songName, labelIndex) => ({
      songName,
      confidence: evidenceByLabel[labelIndex] / totalEvidence
    }))
    .filter((suggestion) => suggestion.songName !== NO_SONG_LABEL && suggestion.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, topK);
}

/** The window step, calculated from the windows, not from the model config. */
