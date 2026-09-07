import path from 'node:path';
import { clamp, hasFlag, parseInt_, parseNum, pct, readArg, resolveDbPath, runMain } from '@core/cli/args';
import {
  TRAIN_CONFIG_DEFAULTS,
  evaluateLeaveOneOut,
  loadAnnotatedMidiFiles,
  saveModel,
  trainModel,
  type TrainConfig
} from './songSegmentation.js';

/**
 * Read an optional numeric flag. Absent means `undefined`, so
 * `resolveTrainConfig` supplies the default — restating defaults here is how
 * the CLI, the rebuild-model route and the fit itself came to disagree.
 */
function optionalNum(flag: string, floor?: number): number | undefined {
  const raw = readArg(flag);
  if (raw === undefined) return undefined;
  const value = parseNum(raw, Number.NaN);
  if (Number.isNaN(value)) throw new Error(`Invalid ${flag} value "${raw}".`);
  return floor === undefined ? value : Math.max(floor, value);
}

function optionalInt(flag: string, floor?: number): number | undefined {
  const value = optionalNum(flag, floor);
  return value === undefined ? undefined : Math.floor(value);
}

function clampOptional(value: number | undefined, min: number, max: number) {
  return value === undefined ? undefined : clamp(value, min, max);
}

function parseScaling(value: string | undefined): TrainConfig['featureScaling'] {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'zscore' || normalized === 'minmax' || normalized === 'none') {
    return normalized;
  }
  throw new Error(`Invalid --scaling value "${value}". Use zscore, minmax, or none.`);
}

function parseScoreMode(value: string | undefined): TrainConfig['scoreMode'] {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'min' || normalized === 'avg') return normalized;
  throw new Error(`Invalid --score-mode value "${value}". Use min or avg.`);
}

function parseDecoder(value: string | undefined): TrainConfig['decoder'] {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'anchor' || normalized === 'viterbi' || normalized === 'smooth') {
    return normalized;
  }
  throw new Error(`Invalid --decoder value "${value}". Use anchor, viterbi, or smooth.`);
}

function parseLinkPolicy(value: string | undefined): TrainConfig['linkPolicy'] {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'legacy' || normalized === 'bridge') return normalized;
  throw new Error(`Invalid --link-policy value "${value}". Use legacy or bridge.`);
}

function usage() {
  console.log(`
Train a MIDI song-segmentation model from local annotations.

Usage:
  npm run ml:train -- [options]

Options:
  --db <path>            SQLite DB path (default: data/jamcoda.db)
  --root <path>          Workspace root for resolving local MIDI paths (default: .)
  --out <path>           Output model path (default: data/ml/model.json)
  --window <seconds>     Window size in seconds (default: 6)
  --step <seconds>       Window step in seconds (default: 1)
  --k <int>              K nearest neighbors (legacy v1 models only; default: 7)
  --none-ratio <float>   Max none:song window ratio kept in training (default: 1.5)
  --prototype-budget <int>     Total condensed prototype budget (default: 8000)
  --max-none-prototypes <int>  Prototype cap for the __none__ class (default: 60)
  --scaling <zscore|minmax|none>  Feature normalization (default: zscore)
  --register-divide <int>        MIDI note separating low/high register chroma (default: 60, middle C)
  --hand-mask-augment <float>    Fraction of song windows given a hand-masked copy (default: 0, off; measured to reduce LOO accuracy)
  --score-mode <min|avg>         Per-label score aggregation (default: min)
  --score-neighbors <int>      Nearest prototypes to average per label (default: 1)
  --decoder <anchor|viterbi|smooth>  Sequential decoding (default: anchor)
  --anchor-margin <float>      Anchor-link seed margin (default: 0.15)
  --min-anchor-run <int>       Minimum anchor windows per seed run (default: 3)
  --fill-min-margin <float>    Minimum margin for a window to be linked (default: 0)
  --fill-topk <int>            Linking affinity top-K (-1 disables; default: -1)
  --link-confidence <n>        Minimum confidence for a linked window (default: 0.5)
  --link-max-silence <float>   A window at or above this silence_ratio cannot be
                               linked into an anchor run (default: 0.7; 1 disables)
  --link-policy <legacy|bridge>  How ambiguous windows join an anchor run
                               (default: legacy). \`bridge\` stops a finished song
                               running into the next one; see ml/CHANGELOG.md
                               2026-09-06 before turning it on
  --link-tail-sec <float>      Seconds an unvouched tail may run past its anchor
                               run (bridge only; default: 2)
  --link-rescue-rank <float>   Mean span rank at which an unlabelled span is
                               given to a neighbouring song (bridge only;
                               default: 5; -1 disables the pass)
  --link-rescue-lookahead <float>  Seconds of lookahead the rescue tests instead
                               of the whole span at once, so a song keeps only the
                               part its evidence covers (bridge only; default: 12;
                               0 restores the whole-span test)
  --trusted-none         Train __none__ only on files marked complete, instead of
                         on every annotated file (default: off — it helps only at
                         a small --prototype-budget; see ml/CHANGELOG.md v2.10)
  --skip-eval            Skip leave-one-file-out evaluation
  --help                 Show this help
`);
}

async function main() {
  if (hasFlag('--help')) {
    usage();
    return;
  }

  const rootDir = path.resolve(readArg('--root') || '.');
  const dbPath = resolveDbPath();
  const outPath = path.resolve(readArg('--out') || 'data/ml/model.json');
  const skipEval = hasFlag('--skip-eval');

  const config: TrainConfig = {
    windowSec: parseNum(readArg('--window'), TRAIN_CONFIG_DEFAULTS.windowSec),
    stepSec: parseNum(readArg('--step'), TRAIN_CONFIG_DEFAULTS.stepSec),
    k: parseInt_(readArg('--k'), TRAIN_CONFIG_DEFAULTS.k),
    maxNoneToSongRatio: Math.max(0, parseNum(readArg('--none-ratio'), TRAIN_CONFIG_DEFAULTS.maxNoneToSongRatio)),
    prototypeBudget: optionalInt('--prototype-budget', 1),
    maxNonePrototypes: optionalInt('--max-none-prototypes', 1),
    featureScaling: parseScaling(readArg('--scaling')),
    registerDivide: optionalInt('--register-divide', 1),
    handMaskAugmentFraction: clampOptional(optionalNum('--hand-mask-augment'), 0, 1),
    scoreMode: parseScoreMode(readArg('--score-mode')),
    scoreNeighbors: optionalInt('--score-neighbors', 1),
    decoder: parseDecoder(readArg('--decoder')),
    anchorMargin: optionalNum('--anchor-margin', 0),
    minAnchorRun: optionalInt('--min-anchor-run', 1),
    fillMinMargin: optionalNum('--fill-min-margin', 0),
    fillTopK: optionalInt('--fill-topk'),
    linkConfidence: clampOptional(optionalNum('--link-confidence'), 0, 1),
    linkMaxSilenceRatio: clampOptional(optionalNum('--link-max-silence'), 0, 1),
    linkPolicy: parseLinkPolicy(readArg('--link-policy')),
    linkTailSec: optionalNum('--link-tail-sec', 0),
    linkRescueRank: optionalNum('--link-rescue-rank', -1),
    linkRescueLookaheadSec: optionalNum('--link-rescue-lookahead', 0),
    noneFromCompleteFilesOnly: hasFlag('--trusted-none') ? true : undefined
  };

  if (config.windowSec <= 0 || config.stepSec <= 0) {
    throw new Error('--window and --step must be > 0.');
  }

  const files = loadAnnotatedMidiFiles(dbPath, rootDir);
  if (files.length < 2) {
    throw new Error(`Need at least 2 annotated files to train robustly. Found ${files.length}.`);
  }

  const annotationCount = files.reduce((sum, file) => sum + file.annotations.length, 0);
  console.log(`Loaded ${files.length} annotated files and ${annotationCount} annotations.`);
  console.log(`Training config: window=${config.windowSec}s, step=${config.stepSec}s, k=${config.k}, none-ratio=${config.maxNoneToSongRatio}`);

  const { model, samplesByFile } = trainModel(files, config);
  saveModel(model, outPath);

  console.log(`Saved model to ${outPath}`);
  console.log(`Samples kept: ${model.trainingSummary.totalSamples} (${model.trainingSummary.positiveSamples} song, ${model.trainingSummary.noneSamples} none)`);
  const droppedNone = model.trainingSummary.noneSamplesDroppedAsUntrusted ?? 0;
  if (droppedNone > 0) {
    const completeFiles = files.filter((file) => file.isComplete).length;
    console.log(
      `__none__ drawn from the ${completeFiles} of ${files.length} files marked complete;`
      + ` ${droppedNone} windows from incomplete files withheld (--trusted-none).`
    );
  }
  console.log(`Labels: ${model.labels.join(', ')}`);

  if (!skipEval) {
    const evalResult = evaluateLeaveOneOut(files, config, samplesByFile);
    if (evalResult.folds.length === 0) {
      console.log('Evaluation skipped (not enough folds after preprocessing).');
      return;
    }

    console.log('\nLeave-one-file-out evaluation:');
    for (const fold of evalResult.folds) {
      console.log(
        `  file ${fold.fileId} (${fold.filename}):`
        + ` overall=${pct(fold.overallAccuracy)}`
        + ` song-only=${pct(fold.songAccuracy)}`
        + ` windows=${fold.totalWindows}`
      );
    }
    console.log(`Mean overall window accuracy: ${pct(evalResult.meanOverallAccuracy)}`);
    console.log(`Mean song-only window accuracy: ${pct(evalResult.meanSongAccuracy)}`);
  }
}

runMain('Training failed', main);
