import path from 'node:path';
import { clamp, hasFlag, parseInt_, parseNum, pct, readArg, resolveDbPath, runMain } from '@core/cli/args';
import {
  evaluateLeaveOneOut,
  loadAnnotatedMidiFiles,
  saveModel,
  trainModel,
  type TrainConfig
} from './songSegmentation.js';

function parseScaling(value: string | undefined): TrainConfig['featureScaling'] {
  if (!value) return 'minmax';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'zscore' || normalized === 'minmax' || normalized === 'none') {
    return normalized;
  }
  throw new Error(`Invalid --scaling value "${value}". Use zscore, minmax, or none.`);
}

function parseScoreMode(value: string | undefined): TrainConfig['scoreMode'] {
  if (!value) return 'min';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'min' || normalized === 'avg') return normalized;
  throw new Error(`Invalid --score-mode value "${value}". Use min or avg.`);
}

function parseDecoder(value: string | undefined): TrainConfig['decoder'] {
  if (!value) return 'anchor';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'anchor' || normalized === 'viterbi' || normalized === 'smooth') {
    return normalized;
  }
  throw new Error(`Invalid --decoder value "${value}". Use anchor, viterbi, or smooth.`);
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
  --window <seconds>     Window size in seconds (default: 4)
  --step <seconds>       Window step in seconds (default: 1)
  --k <int>              K nearest neighbors (legacy v1 models only; default: 7)
  --none-ratio <float>   Max none:song window ratio kept in training (default: 1.5)
  --prototype-budget <int>     Total condensed prototype budget (default: 1200)
  --max-none-prototypes <int>  Prototype cap for the __none__ class (default: 120)
  --scaling <zscore|minmax|none>  Feature normalization (default: minmax)
  --score-mode <min|avg>       Per-label score aggregation (default: min)
  --score-neighbors <int>      Nearest prototypes to average per label (default: 1)
  --decoder <anchor|viterbi|smooth>  Sequential decoding (default: anchor)
  --anchor-margin <float>      Anchor-link seed margin (default: 0.15)
  --min-anchor-run <int>       Minimum anchor windows per seed run (default: 3)
  --fill-min-margin <float>    Minimum margin for a window to be linked (default: 0)
  --fill-topk <int>            Linking affinity top-K (-1 disables; default: -1)
  --link-confidence <n>        Minimum confidence for a linked window (default: 0.5)
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
    windowSec: parseNum(readArg('--window'), 4),
    stepSec: parseNum(readArg('--step'), 1),
    k: parseInt_(readArg('--k'), 7),
    maxNoneToSongRatio: Math.max(0, parseNum(readArg('--none-ratio'), 1.5)),
    prototypeBudget: Math.max(1, parseInt_(readArg('--prototype-budget'), 1200)),
    maxNonePrototypes: Math.max(1, parseInt_(readArg('--max-none-prototypes'), 120)),
    featureScaling: parseScaling(readArg('--scaling')),
    scoreMode: parseScoreMode(readArg('--score-mode')),
    scoreNeighbors: parseInt_(readArg('--score-neighbors'), 1),
    decoder: parseDecoder(readArg('--decoder')),
    anchorMargin: Math.max(0, parseNum(readArg('--anchor-margin'), 0.15)),
    minAnchorRun: Math.max(1, parseInt_(readArg('--min-anchor-run'), 3)),
    fillMinMargin: Math.max(0, parseNum(readArg('--fill-min-margin'), 0)),
    fillTopK: parseInt_(readArg('--fill-topk'), -1, -1),
    linkConfidence: clamp(parseNum(readArg('--link-confidence'), 0.5), 0, 1)
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
