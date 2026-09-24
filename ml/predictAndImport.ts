import path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import {
  clamp,
  ensureDirForFile,
  hasFlag,
  parseBoolean,
  parseInt_,
  parseNum,
  readArg,
  resolveDbPath,
  runMain
} from '@core/cli/args';
import { closeDatabase, initializeDatabase } from '@config/database';
import type { PredictConfig } from './songSegmentation';
import { libraryModelPath } from '@config/library';
import {
  PredictionImportError,
  findFileIdByMidiPath,
  runPredictionImport
} from '../server/services/predictionImport';

/**
 * Predict song segments for one MIDI file and import them as prediction
 * reviews.
 *
 * The pipeline lives in `server/services/predictionImport`, shared with
 * `POST /api/prediction-reviews/run`; this file is argument parsing and
 * reporting only. Schema is the migration runner's job, never this one's.
 */

function usage() {
  console.log(`
Predict song segments and import them into prediction_reviews.

Usage:
  npm run ml:predict-import -- --midi <path> [options]

Options:
  --midi <path>                 MIDI file path (required)
  --model <path>                Model path (default: ml/model.json beside the database)
  --db <path>                   SQLite DB path (default: data/jamcoda.db)
  --model-version <value>       Stored with imported rows (default: <modelType>@<createdAt>)
  --out <path>                  Optional prediction JSON output path
  --clear-unpromoted <true|false>  Clear existing unpromoted reviews for file first (default: true)
  --dry-run                     Do not write to DB, only print summary
  --min-window-confidence <n>   Window confidence threshold (default: 0.45)
  --smoothing <int>             Smoothing windows (default: 5)
  --min-segment-sec <n>         Minimum segment duration (default: 8)
  --min-segment-confidence <n>  Minimum average segment confidence (default: 0.3)
  --merge-gap-sec <n>           Merge adjacent same-song segments within gap (default: 5)
  --min-skip-split-sec <n>      Split segments at silence gaps >= this many seconds (default: 30; 0 disables)
  --help                        Show this help
`);
}

async function main() {
  if (hasFlag('--help')) {
    usage();
    return;
  }

  const midiArg = readArg('--midi');
  if (!midiArg) {
    usage();
    throw new Error('Missing required --midi path.');
  }

  const midiPath = path.resolve(midiArg);
  const modelPath = readArg('--model') ? path.resolve(readArg('--model')!) : libraryModelPath(resolveDbPath());
  const outArg = readArg('--out');
  const outPath = outArg ? path.resolve(outArg) : undefined;

  if (!existsSync(modelPath)) {
    throw new Error(`Model file does not exist: ${modelPath}`);
  }

  // The models read through `@config/database`, which resolves the DB path
  // from JAMCODA_DB_PATH. Honor --db by setting it before connecting.
  process.env.JAMCODA_DB_PATH = resolveDbPath();

  // Applies pending migrations too, so the schema this CLI writes against is
  // whatever the migration runner defines. Schema is never this file's job.
  const { appliedMigrations } = initializeDatabase();
  if (appliedMigrations.length > 0) {
    console.log(`Applied ${appliedMigrations.length} pending migration(s).`);
  }

  const config: PredictConfig = {
    minWindowConfidence: clamp(parseNum(readArg('--min-window-confidence'), 0.45), 0, 1),
    smoothingWindows: parseInt_(readArg('--smoothing'), 5),
    minSegmentSec: Math.max(0, parseNum(readArg('--min-segment-sec'), 8)),
    minSegmentConfidence: clamp(parseNum(readArg('--min-segment-confidence'), 0.3), 0, 1),
    mergeGapSec: Math.max(0, parseNum(readArg('--merge-gap-sec'), 5))
  };

  const fileId = findFileIdByMidiPath(midiPath);

  const result = runPredictionImport({
    fileId,
    modelPath,
    config,
    clearUnpromoted: parseBoolean(readArg('--clear-unpromoted'), true),
    modelVersion: readArg('--model-version'),
    minSkipSplitSec: Math.max(0, parseNum(readArg('--min-skip-split-sec'), 30)),
    dryRun: hasFlag('--dry-run')
  });

  if (result.segments.length === 0) {
    console.log('No confident segments found with current thresholds.');
  } else {
    console.log(`Predicted ${result.segments.length} segment(s) for file_id=${result.fileId}:`);
    for (const segment of result.segments) {
      console.log(
        `  ${segment.songName}`
        + ` | ${segment.startTime.toFixed(1)}s - ${segment.endTime.toFixed(1)}s`
        + ` | conf=${segment.confidence.toFixed(2)}`
      );
    }
  }

  if (result.annotatedRangeCount > 0) {
    console.log(
      `Excluded ranges: ${result.annotatedRangeCount} annotated;`
      + ` altered ${result.excludedSegmentCount} of ${result.rawSegmentCount} raw segment(s).`
    );
  }

  if (result.bookmarks.length > 0 || result.skips.length > 0) {
    console.log(
      `Device boundaries: ${result.bookmarks.length} bookmark(s), `
      + `${result.skips.length} silence gap(s);`
      + ` split/trimmed ${result.bookmarkSplitCount} segment(s) at bookmarks`
      + ` and ${result.skipSplitCount} at silence gaps.`
    );
  }

  if (outPath) {
    ensureDirForFile(outPath);
    writeFileSync(outPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      midiPath: result.midiPath,
      modelPath,
      dbPath: process.env.JAMCODA_DB_PATH,
      fileId: result.fileId,
      config: { ...result.config, ...result.modelConfig },
      segments: result.segments
    }, null, 2), 'utf8');
    console.log(`Wrote prediction JSON to ${outPath}`);
  }

  if (result.dryRun) {
    console.log('Dry run enabled. Skipping DB import.');
    return;
  }

  console.log(
    `Imported ${result.insertedCount} prediction review row(s) for file_id=${result.fileId}`
    + (result.clearedCount > 0
      ? ` (cleared ${result.clearedCount} previous unpromoted row(s) first).`
      : '.')
  );
  console.log(`Open #/detail/${result.fileId} to review in the UI.`);
}

runMain('Predict/import failed', async () => {
  try {
    await main();
  } catch (error) {
    if (error instanceof PredictionImportError) {
      throw new Error(error.message);
    }
    throw error;
  } finally {
    closeDatabase();
  }
});
