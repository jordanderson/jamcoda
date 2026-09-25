/**
 * Training configuration: the defaults, and how a partial config resolves.
 *
 * `resolveTrainConfig` fills every field, so a model records the settings it
 * was built with. Read the `linkPolicy` note in `types.ts` before changing a
 * default -- a new default must never move an existing model.
 */
import type { TrainConfig } from './types';

export function decoderIgnoredOptions(decoder: TrainConfig['decoder']): string[] {
  const resolved = decoder ?? 'anchor';
  if (resolved === 'anchor') return ['minWindowConfidence', 'smoothingWindows'];
  if (resolved === 'viterbi') return ['smoothingWindows'];
  return [];
}

/**
 * Defaults for the four fields `TrainConfig` requires. Every optional field's
 * default lives in `resolveTrainConfig`. Both entry points that build a config
 * from user input — `ml/train.ts` and the `rebuild-model` route — read these,
 * so the CLI and the sidebar button cannot train different models.
 */
export const TRAIN_CONFIG_DEFAULTS = {
  windowSec: 6,
  stepSec: 1,
  k: 7,
  maxNoneToSongRatio: 1.5
} as const;

/**
 * Config fields the decoder reads but the fit never sees.
 *
 * Changing one of these re-decodes existing scores instead of retraining, so
 * two runs that differ only here are directly comparable — which is what makes
 * the eval score cache safe to reuse and what lets a prediction preview try a
 * decoder setting without rebuilding the model. One definition, because a
 * second copy that disagreed would silently serve stale scores.
 */
export const DECODE_ONLY_CONFIG_KEYS = [
  'decoder', 'viterbiChangePenalty', 'temperature', 'anchorMargin', 'minAnchorRun',
  'fillMinMargin', 'fillTopK', 'linkConfidence', 'linkMaxSilenceRatio', 'anchorGapPolicy',
  'linkPolicy', 'linkTailSec', 'linkRescueRank', 'linkRescueLookaheadSec', 'dropFlankedRunSec'
] as const;

export type DecodeOnlyConfig = Partial<Pick<TrainConfig, typeof DECODE_ONLY_CONFIG_KEYS[number]>>;

/**
 * A `TrainConfig` with every optional field filled in. Anything that builds the
 * model takes this rather than the caller's partial config, so a default has
 * exactly one definition (`resolveTrainConfig`) and cannot be restated — and
 * disagreed with — at a use site.
 */
export type ResolvedTrainConfig = Required<
  Pick<
    TrainConfig,
    'prototypeBudget' | 'maxNonePrototypes' | 'featureScaling' | 'scoreMode'
    | 'scoreNeighbors' | 'decoder' | 'anchorMargin' | 'minAnchorRun'
    | 'fillMinMargin' | 'fillTopK' | 'linkConfidence' | 'temperature'
    | 'viterbiChangePenalty' | 'kernelScale' | 'registerDivide'
    | 'handMaskAugmentFraction' | 'noneFromCompleteFilesOnly' | 'chordIoiFeatures' | 'centerWindowSec'
    | 'linkMaxSilenceRatio' | 'linkPolicy' | 'dropFlankedRunSec'
  >
> & TrainConfig;

/**
 * The config to refit a saved model from, with every setting that decides
 * which features are extracted pinned to how that model was built: a model
 * saved without `chordIoiFeatures` extracts the base features. Refit from this,
 * never from the raw saved config, or a later default would retrain an old
 * model with features it never had.
 */
export function refitConfigOf(config: TrainConfig): TrainConfig {
  return { ...config, chordIoiFeatures: config.chordIoiFeatures ?? false };
}

/**
 * Resolve each optional setting to the value that the fit and the decoder
 * use. Defaults are applied here. A saved model records these values, so a
 * change to a default does not change the behavior of an existing model.
 */
export function resolveTrainConfig(config: TrainConfig): ResolvedTrainConfig {
  const resolved: ResolvedTrainConfig = {
    ...config,
    prototypeBudget: config.prototypeBudget ?? 16000,
    maxNonePrototypes: config.maxNonePrototypes ?? 60,
    featureScaling: config.featureScaling ?? 'zscore',
    noneFromCompleteFilesOnly: config.noneFromCompleteFilesOnly ?? true,
    linkMaxSilenceRatio: config.linkMaxSilenceRatio ?? 0.7,
    registerDivide: config.registerDivide ?? 60,
    chordIoiFeatures: config.chordIoiFeatures ?? true,
    centerWindowSec: config.centerWindowSec ?? 0,
    handMaskAugmentFraction: config.handMaskAugmentFraction ?? 0,
    scoreMode: config.scoreMode ?? 'min',
    scoreNeighbors: config.scoreNeighbors ?? 1,
    decoder: config.decoder ?? 'anchor',
    anchorMargin: config.anchorMargin ?? 0.15,
    minAnchorRun: config.minAnchorRun ?? 3,
    fillMinMargin: config.fillMinMargin ?? 0,
    fillTopK: config.fillTopK ?? -1,
    linkConfidence: config.linkConfidence ?? 0.5,
    temperature: config.temperature ?? 1,
    viterbiChangePenalty: config.viterbiChangePenalty ?? 1,
    kernelScale: config.kernelScale ?? 0,
    linkPolicy: config.linkPolicy ?? 'bridge',
    dropFlankedRunSec: config.dropFlankedRunSec ?? 30
  };

  // Bridge linking's thresholds are resolved only when that policy is on. What
  // they mean depends on `linkPolicy`, so writing them into a model built with
  // legacy linking would freeze values the decoder never used, and would then
  // quietly disagree with it if that model's policy were changed later.
  //
  // The default is `bridge` here, at fit time, and nowhere else: the decoder
  // still reads an *absent* policy as legacy, so a model saved before this
  // change keeps decoding exactly as it did. Only a model built from here on
  // records `bridge`, and it records it explicitly.
  if (resolved.linkPolicy === 'bridge') {
    resolved.linkTailSec = resolved.linkTailSec ?? 2;
    resolved.linkRescueRank = resolved.linkRescueRank ?? 5;
    resolved.linkRescueLookaheadSec = resolved.linkRescueLookaheadSec ?? 0;
  }

  return resolved;
}
