import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  clamp,
  hasFlag,
  parseInt_,
  parseNum,
  readArg,
  resolveDbPath,
  runMain
} from '@core/cli/args';
import { closeDatabase, getDb, initializeDatabase } from '@config/database';
import type { PredictConfig } from './songSegmentation';
import {
  PredictionImportError,
  runPredictionImport
} from '../server/services/predictionImport';

/**
 * Run predictions for every file that is incomplete, has notes, and has no
 * prediction rows yet. With --force, every incomplete non-empty file is
 * re-run and existing unpromoted predictions are regenerated.
 *
 * "No predictions yet" means zero rows in `prediction_reviews` for the file.
 * A file whose predictions were all promoted or invalidated has rows and is
 * skipped unless --force is given. Files marked complete are never touched:
 * completion is authoritative and blocks the pipeline.
 *
 * This is the same pipeline as `POST /api/prediction-reviews/run` and
 * `ml:predict-import` (`runPredictionImport`), so exclusion of annotated and
 * ignored ranges, bookmark/silence-gap splitting, and insert shape all match.
 */

interface Candidate {
  id: number;
  filename: string;
  localPath: string;
}

function usage() {
  console.log(`
Run predictions for files that do not have any yet.

Usage:
  npm run ml:predict-missing -- [options]

Options:
  --model <path>                Model path (default: data/ml/model.json)
  --db <path>                   SQLite DB path (default: data/jamcoda.db)
  --root <path>                 Workspace root for file lookup (default: .)
  --force                       Also re-run files that already have predictions
  --limit <n>                   Only process the first n candidate files
  --dry-run                     Do not write to DB, only print what would run
  --model-version <value>       Stored with imported rows (default: <modelType>@<createdAt>)
  --min-window-confidence <n>   Window confidence threshold (default: 0.45)
  --smoothing <int>             Smoothing windows (default: 5)
  --min-segment-sec <n>         Minimum segment duration (default: 8)
  --min-segment-confidence <n>  Minimum average segment confidence (default: 0.3)
  --merge-gap-sec <n>           Merge adjacent same-song segments within gap (default: 5)
  --min-skip-split-sec <n>      Split segments at silence gaps >= this many seconds (default: 30)
  --help                        Show this help
`);
}

function findCandidates(force: boolean, limit: number | null): Candidate[] {
  const forceClause = force
    ? ''
    : ` AND NOT EXISTS (
        SELECT 1 FROM prediction_reviews pr WHERE pr.file_id = f.id
      )`;

  const limitSql = limit !== null ? ` LIMIT ${Math.max(0, Math.floor(limit))}` : '';
  const rows = getDb().prepare(`
    SELECT f.id, f.filename, f.local_path as localPath
    FROM files f
    WHERE f.is_complete = 0
      AND (f.midi_duration IS NULL OR f.midi_duration > 0)
      ${forceClause}
    ORDER BY f.date_recorded DESC, f.filename ASC
    ${limitSql}
  `).all() as Candidate[];
  return rows;
}

async function main() {
  if (hasFlag('--help')) {
    usage();
    return;
  }

  const modelPath = path.resolve(readArg('--model') || 'data/ml/model.json');
  const rootDir = path.resolve(readArg('--root') || '.');
  const dbPath = resolveDbPath();
  const force = hasFlag('--force');
  const dryRun = hasFlag('--dry-run');
  const limitArg = readArg('--limit');
  const limit = limitArg ? parseInt_(limitArg, 1) : null;

  if (!existsSync(modelPath)) {
    throw new Error(`Model file does not exist: ${modelPath}`);
  }

  process.env.JAMCODA_DB_PATH = dbPath;
  initializeDatabase();

  const config: PredictConfig = {
    minWindowConfidence: clamp(parseNum(readArg('--min-window-confidence'), 0.45), 0, 1),
    smoothingWindows: parseInt_(readArg('--smoothing'), 5),
    minSegmentSec: Math.max(0, parseNum(readArg('--min-segment-sec'), 8)),
    minSegmentConfidence: clamp(parseNum(readArg('--min-segment-confidence'), 0.3), 0, 1),
    mergeGapSec: Math.max(0, parseNum(readArg('--merge-gap-sec'), 5))
  };
  const minSkipSplitSec = Math.max(0, parseNum(readArg('--min-skip-split-sec'), 30));

  try {
    const candidates = findCandidates(force, limit);
    console.log(`Database: ${dbPath}`);
    console.log(
      `${candidates.length} incomplete file${candidates.length !== 1 ? 's' : ''} `
      + `${force ? '(--force: including ones that already have predictions)' : 'without predictions yet'}`
    );

    if (candidates.length === 0) {
      console.log('Nothing to do.');
      return;
    }

    if (dryRun) {
      for (const candidate of candidates) {
        console.log(`  would run: #${candidate.id} ${candidate.filename}`);
      }
      console.log(`\nDry run. Re-run without --dry-run to import predictions.`);
      return;
    }

    let predicted = 0;
    let segmentsInserted = 0;
    let skippedMissing = 0;
    const errors: Array<{ file: string; error: string }> = [];

    for (const candidate of candidates) {
      if (!existsSync(candidate.localPath)) {
        console.log(`  #${candidate.id} ${candidate.filename}: skipped (MIDI not on disk)`);
        skippedMissing++;
        continue;
      }

      try {
        const result = runPredictionImport({
          fileId: candidate.id,
          modelPath,
          config,
          clearUnpromoted: true,
          modelVersion: readArg('--model-version'),
          minSkipSplitSec,
          rootDir
        });
        predicted++;
        segmentsInserted += result.insertedCount;
        console.log(
          `  #${candidate.id} ${candidate.filename}: ${result.segments.length} segment(s)`
          + ` (inserted ${result.insertedCount})`
        );
      } catch (error) {
        if (error instanceof PredictionImportError) {
          console.error(`  #${candidate.id} ${candidate.filename}: ${error.message}`);
          errors.push({ file: candidate.filename, error: error.message });
          continue;
        }
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`  #${candidate.id} ${candidate.filename}: ${message}`);
        errors.push({ file: candidate.filename, error: message });
      }
    }

    console.log(
      `\nDone: ${predicted} file(s) predicted, ${segmentsInserted} segment(s) imported, `
      + `${skippedMissing} skipped (missing MIDI), ${errors.length} error(s).`
    );
    if (errors.length > 0) {
      console.log('Open #/reviews to triage the new predictions.');
    }
  } finally {
    closeDatabase();
  }
}

runMain('Batch prediction failed', main);