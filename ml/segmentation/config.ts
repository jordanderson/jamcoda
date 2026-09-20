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
  'linkPolicy', 'linkTailSec', 'linkRescueRank', 'linkRescueLookaheadSec'
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
    | 'handMaskAugmentFraction' | 'noneFromCompleteFilesOnly'
    | 'linkMaxSilenceRatio' | 'linkPolicy'
  >
> & TrainConfig;

export function resolveTrainConfig(config: TrainConfig): ResolvedTrainConfig {
  const resolved: ResolvedTrainConfig = {
    ...config,
    prototypeBudget: config.prototypeBudget ?? 8000,
    maxNonePrototypes: config.maxNonePrototypes ?? 60,
    featureScaling: config.featureScaling ?? 'zscore',
    noneFromCompleteFilesOnly: config.noneFromCompleteFilesOnly ?? false,
    linkMaxSilenceRatio: config.linkMaxSilenceRatio ?? 0.7,
    registerDivide: config.registerDivide ?? 60,
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
    linkPolicy: config.linkPolicy ?? 'bridge'
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

/**
 * Read-only query against the app database.
 *
 * Previously this shelled out to the `sqlite3` CLI, an undeclared system
 * requirement that made `ml:train` fail on a fresh clone without it. The
 * server already depends on better-sqlite3, so this uses that instead.
 */
