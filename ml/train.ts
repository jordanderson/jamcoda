import path from 'node:path';
import {
  evaluateLeaveOneOut,
  loadAnnotatedMidiFiles,
  saveModel,
  trainModel,
  type TrainConfig
} from './songSegmentation.js';

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
  --k <int>              K nearest neighbors (default: 7)
  --none-ratio <float>   Max none:song window ratio kept in training (default: 1.5)
  --skip-eval            Skip leave-one-file-out evaluation
  --help                 Show this help
`);
}

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parseNum(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main() {
  if (hasFlag('--help')) {
    usage();
    return;
  }

  const rootDir = path.resolve(readArg('--root') || '.');
  const dbPath = path.resolve(readArg('--db') || process.env.JAMCODA_DB_PATH || 'data/jamcoda.db');
  const outPath = path.resolve(readArg('--out') || 'data/ml/model.json');
  const skipEval = hasFlag('--skip-eval');

  const config: TrainConfig = {
    windowSec: parseNum(readArg('--window'), 4),
    stepSec: parseNum(readArg('--step'), 1),
    k: Math.max(1, Math.floor(parseNum(readArg('--k'), 7))),
    maxNoneToSongRatio: Math.max(0, parseNum(readArg('--none-ratio'), 1.5))
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

main().catch((error) => {
  console.error('Training failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
