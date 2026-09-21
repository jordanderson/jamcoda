/**
 * Fitting, saving and loading a prototype model.
 *
 * Training keeps an evenly spaced sample of the labelled windows -- the
 * prototypes -- and a new window is scored by its distance to the nearest
 * one. There is no neural network here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { ensureDirForFile } from '@core/cli/args';
import {
  CHROMA_SIZE,
  FEATURE_NAMES,
  HIGH_CHROMA_START,
  LOW_CHROMA_START,
  LOW_REGISTER_RATIO_INDEX,
  MODEL_VERSION,
  NO_SONG_LABEL,
  type SongSegmentModel,
  type TrainConfig,
  type WindowSample
} from './types';
import { resolveTrainConfig, type ResolvedTrainConfig } from './config';
import { evenlySample, normalizeVector, squaredDistance, standardize } from './vectors';

function allocatePrototypeBudgets(
  support: Map<number, number>,
  config: ResolvedTrainConfig,
  noneLabelIndex: number
): Map<number, number> {
  const maxTotal = Math.max(1, config.prototypeBudget);
  const maxNone = Math.max(1, config.maxNonePrototypes);

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
    if (labelIndex === noneLabelIndex) budget = Math.min(budget, maxNone);
    budgets.set(labelIndex, budget);
  }
  return budgets;
}

/**
 * Estimate the exp(-d/sigma) kernel scale from the training distribution:
 * the median distance from a sample to its nearest prototype. A deterministic
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
  config: ResolvedTrainConfig,
  noneLabelIndex: number
): {
  prototypes: Array<{ features: number[]; labelIndex: number }>;
  prototypeCounts: number[];
  kernelScale: number;
  scoreNeighbors: number;
  perLabelBudget: number;
  underBudgetLabels: number[];
  labelCount: number;
} {
  const labelCount = normalizedGroups.size === 0 ? 0 : Math.max(...normalizedGroups.keys()) + 1;
  const support = new Map<number, number>();
  for (const [labelIndex, vectors] of normalizedGroups) support.set(labelIndex, vectors.length);

  const budgets = allocatePrototypeBudgets(support, config, noneLabelIndex);
  const songLabelCount = Math.max(1, support.size - (support.has(noneLabelIndex) ? 1 : 0));
  const perLabelBudget = Math.max(
    1,
    Math.floor(Math.max(1, config.prototypeBudget) / songLabelCount)
  );
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

  // Score every label on the same number of neighbours. More neighbours give
  // a label an advantage, so the smallest per-label count sets the limit.
  const smallestCount = prototypeCounts.reduce(
    (min, count) => (count > 0 && count < min ? count : min),
    Number.POSITIVE_INFINITY
  );
  const requested = Math.max(1, Math.floor(config.scoreNeighbors));
  const scoreNeighbors = Number.isFinite(smallestCount)
    ? Math.max(1, Math.min(requested, smallestCount))
    : 1;

  // The kernel scale is read only by 'avg' scoring, but the field must stay
  // populated (`loadModel`/tests and saved-model shape). In 'min' mode — every
  // shipped config — estimate it on a token sample: the full 800-window sweep
  // cost ~21-28% of every leave-one-out fold for a value nothing reads.
  const kernelScale = estimateKernelScale(
    normalizedGroups,
    prototypes,
    config.scoreMode === 'avg' ? 800 : 50
  );
  const underBudgetLabels: number[] = [];
  for (const [labelIndex, count] of support) {
    if (labelIndex !== noneLabelIndex && count < perLabelBudget) underBudgetLabels.push(labelIndex);
  }

  return {
    prototypes,
    prototypeCounts,
    kernelScale,
    scoreNeighbors,
    perLabelBudget,
    underBudgetLabels,
    labelCount
  };
}

/**
 * Deterministic hand-mask augmentation.
 *
 * A fraction of the annotated (song) windows is duplicated with one register
 * zeroed out: the low or high chroma block is set to 0 and
 * `low_register_ratio` is set to the extreme that matches the remaining
 * register. The copy keeps the original label, so the model learns that a
 * one-hand performance of a song still belongs to that song.
 *
 * A window whose target register already carries no content is left alone:
 * zeroing the last active register would turn a song window into a
 * silence-shaped vector still labelled as the song, which is exactly the
 * false-positive source this augmentation must avoid.
 *
 * Selection uses an even stride over the positive windows and alternates
 * which hand is masked, with no RNG, so training and leave-one-out eval stay
 * deterministic.
 */
function augmentHandMask(positive: WindowSample[], fraction: number): WindowSample[] {
  if (!(fraction > 0) || positive.length === 0) return [];

  const count = Math.round(positive.length * fraction);
  if (count === 0) return [];

  const stride = positive.length / count;
  const augmented: WindowSample[] = [];
  for (let k = 0; k < count; k++) {
    const idx = Math.min(positive.length - 1, Math.floor(k * stride));
    const sample = positive[idx];
    const maskLow = k % 2 === 0;
    const maskStart = maskLow ? LOW_CHROMA_START : HIGH_CHROMA_START;
    const keepStart = maskLow ? HIGH_CHROMA_START : LOW_CHROMA_START;
    if (!registerHasContent(sample.features, keepStart)) continue;

    const features = sample.features.slice();
    for (let i = 0; i < CHROMA_SIZE; i++) {
      features[maskStart + i] = 0;
    }
    features[LOW_REGISTER_RATIO_INDEX] = maskLow ? 0 : 1;
    augmented.push({ ...sample, features });
  }
  return augmented;
}

function registerHasContent(features: number[], chromaStart: number): boolean {
  for (let i = 0; i < CHROMA_SIZE; i++) {
    if (features[chromaStart + i] > 1e-9) return true;
  }
  return false;
}

export function fitModelFromSamples(
  samples: WindowSample[],
  config: TrainConfig,
  trainingSummaryOverride?: Partial<SongSegmentModel['trainingSummary']>
): SongSegmentModel {
  if (samples.length === 0) {
    throw new Error('No training samples produced. Add annotations first.');
  }

  // Resolve once, then build from the resolved values only. The model saves
  // this same object, so reading a default off the caller's partial config
  // would let the saved config describe a model that was not built that way.
  const resolved = resolveTrainConfig(config);

  const positive = samples.filter((sample) => sample.label !== NO_SONG_LABEL);
  const allNegative = samples.filter((sample) => sample.label === NO_SONG_LABEL);
  // An unannotated window only means "no song" in a file the user marked
  // complete. See `noneFromCompleteFilesOnly`.
  const trustedNegative = resolved.noneFromCompleteFilesOnly
    ? allNegative.filter((sample) => sample.fileIsComplete)
    : allNegative;
  const negative = trustedNegative.length > 0 ? trustedNegative : allNegative;
  const augmented = augmentHandMask(positive, resolved.handMaskAugmentFraction);
  const maxNone = Math.max(1, Math.floor(positive.length * resolved.maxNoneToSongRatio));
  const keptNegative = evenlySample(negative, maxNone);
  const kept = [...positive, ...augmented, ...keptNegative];

  const labels = [...new Set(kept.map((sample) => sample.label))].sort((a, b) => {
    if (a === NO_SONG_LABEL) return -1;
    if (b === NO_SONG_LABEL) return 1;
    return a.localeCompare(b);
  });
  const labelToIndex = new Map(labels.map((label, idx) => [label, idx]));

  const rawVectors = kept.map((sample) => sample.features);
  const { means, stds } = standardize(rawVectors, resolved.featureScaling);

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

  const noneLabelIndex = labelToIndex.get(NO_SONG_LABEL) ?? -1;
  const {
    prototypes, prototypeCounts, kernelScale, scoreNeighbors,
    perLabelBudget, underBudgetLabels
  } = buildPrototypesFromGroups(normalizedGroups, resolved, noneLabelIndex);

  const labelCounts: Record<string, number> = {};
  for (const sample of kept) {
    labelCounts[sample.label] = (labelCounts[sample.label] || 0) + 1;
  }

  const distinctFiles = new Set(kept.map((sample) => sample.fileId));
  const model: SongSegmentModel = {
    modelType: 'knn-song-segmenter',
    version: 2,
    modelVersion: MODEL_VERSION,
    createdAt: new Date().toISOString(),
    // Save the resolved config, not the partial config from the caller. A
    // model that omits `decoder`, `scoreMode` or `featureScaling` changes
    // behaviour when a default changes.
    config: resolved,
    featureNames: [...FEATURE_NAMES],
    labels,
    featureMeans: means,
    featureStds: stds,
    prototypes,
    prototypeCounts,
    kernelScale,
    scoreNeighbors,
    trainingSummary: {
      filesUsed: distinctFiles.size,
      annotationsUsed: trainingSummaryOverride?.annotationsUsed ?? 0,
      totalSamples: kept.length,
      positiveSamples: positive.length,
      augmentedSamples: augmented.length,
      noneSamples: keptNegative.length,
      noneSamplesDroppedAsUntrusted: allNegative.length - negative.length,
      labelCounts,
      prototypesPerLabel: perLabelBudget,
      underAnnotatedLabels: underBudgetLabels
        .filter((labelIndex) => labelIndex !== noneLabelIndex)
        .map((labelIndex) => labels[labelIndex]),
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

// A model with a different feature set fails without an error.
    // `normalizeVector` reads past the end of `featureMeans`, so each distance
    // becomes NaN. Every comparison with NaN is false, and the decoder
    // returns `__none__` for every window. The user sees 0 segments and no
    // error. The feature vector changed from 18 to 25 entries in v2.0, so
    // check it.
  const expected = FEATURE_NAMES as readonly string[];
  const actual = Array.isArray(parsed.featureNames) ? parsed.featureNames : [];
  const mismatched = actual.length !== expected.length
    || actual.some((name, idx) => name !== expected[idx]);
  if (mismatched) {
    throw new Error(
      `Model was trained with a different feature set (${actual.length} features, `
      + `this build extracts ${expected.length}). Retrain it: `
      + 'npm run ml:train -- --out <model path>, or use "Rebuild Model" in the sidebar.'
    );
  }
  if (parsed.featureMeans?.length !== expected.length || parsed.featureStds?.length !== expected.length) {
    throw new Error('Model normalization constants do not match its feature set. Retrain the model.');
  }

  return parsed;
}
