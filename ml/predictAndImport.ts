import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  loadModel,
  predictWindows,
  windowsToSegments,
  type PredictConfig
} from './songSegmentation.js';

interface JsonOutputPayload {
  generatedAt: string;
  midiPath: string;
  modelPath: string;
  dbPath: string;
  fileId: number;
  config: PredictConfig & {
    windowSec: number;
    stepSec: number;
    k: number;
  };
  segments: Array<{
    songName: string;
    startTime: number;
    endTime: number;
    durationSec: number;
    confidence: number;
  }>;
}

interface TimeRange {
  startTime: number;
  endTime: number;
}

function usage() {
  console.log(`
Predict song segments and import them into prediction_reviews.

Usage:
  npm run ml:predict-import -- --midi <path> [options]

Options:
  --midi <path>                 MIDI file path (required)
  --model <path>                Model path (default: data/ml/model.json)
  --db <path>                   SQLite DB path (default: data/jamcoda.db)
  --root <path>                 Workspace root for file lookup (default: .)
  --model-version <value>       Stored with imported rows (default: <modelType>@<createdAt>)
  --out <path>                  Optional prediction JSON output path
  --clear-unpromoted <true|false>  Clear existing unpromoted reviews for file first (default: true)
  --dry-run                     Do not write to DB, only print summary
  --min-window-confidence <n>   Window confidence threshold (default: 0.45)
  --smoothing <int>             Smoothing windows (default: 5)
  --min-segment-sec <n>         Minimum segment duration (default: 8)
  --min-segment-confidence <n>  Minimum average segment confidence (default: 0.65)
  --merge-gap-sec <n>           Merge adjacent same-song segments within gap (default: 3)
  --help                        Show this help
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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ensureDirForFile(filePath: string) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function sqliteQueryJson<T>(dbPath: string, sql: string): T[] {
  const stdout = execFileSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf8'
  }).trim();

  if (!stdout) return [];
  return JSON.parse(stdout) as T[];
}

function sqliteExec(dbPath: string, sql: string): void {
  execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
}

function ensurePredictionReviewsSchema(dbPath: string): void {
  sqliteExec(
    dbPath,
    `
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS prediction_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        predicted_song_name TEXT NOT NULL,
        predicted_start_time REAL NOT NULL,
        predicted_end_time REAL NOT NULL,
        predicted_confidence REAL,
        status TEXT NOT NULL DEFAULT 'unsure',
        reviewed_song_name TEXT,
        reviewed_start_time REAL,
        reviewed_end_time REAL,
        review_notes TEXT,
        model_version TEXT,
        promoted_annotation_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        reviewed_at INTEGER,
        promoted_at INTEGER,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
        FOREIGN KEY (promoted_annotation_id) REFERENCES annotations(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_prediction_reviews_file_id ON prediction_reviews(file_id);
      CREATE INDEX IF NOT EXISTS idx_prediction_reviews_status ON prediction_reviews(status);
      CREATE INDEX IF NOT EXISTS idx_prediction_reviews_created_at ON prediction_reviews(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prediction_reviews_promoted ON prediction_reviews(promoted_annotation_id);

      CREATE TABLE IF NOT EXISTS ignored_sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        start_time REAL NOT NULL,
        end_time REAL NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ignored_sections_file_id ON ignored_sections(file_id);
      CREATE INDEX IF NOT EXISTS idx_ignored_sections_time ON ignored_sections(file_id, start_time, end_time);
    `
  );
}

function normalizeRanges(ranges: TimeRange[]): TimeRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges]
    .filter((range) => Number.isFinite(range.startTime) && Number.isFinite(range.endTime) && range.endTime > range.startTime)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);

  if (sorted.length === 0) return [];
  const merged: TimeRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.startTime <= last.endTime) {
      last.endTime = Math.max(last.endTime, current.endTime);
      continue;
    }
    merged.push({ ...current });
  }
  return merged;
}

function removeExcludedRangesFromSegments(
  segments: JsonOutputPayload['segments'],
  excludedRanges: TimeRange[],
  minSegmentSec: number
): JsonOutputPayload['segments'] {
  if (segments.length === 0 || excludedRanges.length === 0) return segments;
  const normalized = normalizeRanges(excludedRanges);
  if (normalized.length === 0) return segments;

  const kept: JsonOutputPayload['segments'] = [];
  for (const segment of segments) {
    let cursor = segment.startTime;
    for (const ignored of normalized) {
      if (ignored.endTime <= cursor) continue;
      if (ignored.startTime >= segment.endTime) break;

      const keptEnd = Math.min(ignored.startTime, segment.endTime);
      if (keptEnd > cursor) {
        const durationSec = keptEnd - cursor;
        if (durationSec >= minSegmentSec) {
          kept.push({
            ...segment,
            startTime: cursor,
            endTime: keptEnd,
            durationSec
          });
        }
      }

      cursor = Math.max(cursor, ignored.endTime);
      if (cursor >= segment.endTime) break;
    }

    if (cursor < segment.endTime) {
      const durationSec = segment.endTime - cursor;
      if (durationSec >= minSegmentSec) {
        kept.push({
          ...segment,
          startTime: cursor,
          endTime: segment.endTime,
          durationSec
        });
      }
    }
  }
  return kept;
}

function resolveFileId(dbPath: string, rootDir: string, midiPathAbs: string): number {
  const midiPathRel = path.relative(rootDir, midiPathAbs).split(path.sep).join('/');
  const midiPathAbsNormalized = midiPathAbs.split(path.sep).join('/');
  const relEscaped = sqlEscape(midiPathRel);
  const absEscaped = sqlEscape(midiPathAbsNormalized);

  const rows = sqliteQueryJson<Array<{ id: number }[number]>>(
    dbPath,
    `
      SELECT id
      FROM files
      WHERE local_path = '${relEscaped}'
         OR local_path = '${absEscaped}'
      LIMIT 1
    `
  );

  if (rows.length === 0) {
    throw new Error(
      `Could not find file_id for MIDI path in files table.\n` +
      `Tried local_path = ${midiPathRel} and ${midiPathAbsNormalized}`
    );
  }

  return Number(rows[0].id);
}

function loadIgnoredRanges(dbPath: string, fileId: number): TimeRange[] {
  const rows = sqliteQueryJson<Array<{ start_time: number; end_time: number }[number]>>(
    dbPath,
    `
      SELECT start_time, end_time
      FROM ignored_sections
      WHERE file_id = ${fileId}
        AND end_time > start_time
      ORDER BY start_time ASC
    `
  );

  return rows.map((row) => ({
    startTime: Number(row.start_time),
    endTime: Number(row.end_time)
  }));
}

function loadAnnotationRanges(dbPath: string, fileId: number): TimeRange[] {
  const rows = sqliteQueryJson<Array<{ start_time: number; end_time: number }[number]>>(
    dbPath,
    `
      SELECT start_time, end_time
      FROM annotations
      WHERE file_id = ${fileId}
        AND end_time > start_time
      ORDER BY start_time ASC
    `
  );

  return rows.map((row) => ({
    startTime: Number(row.start_time),
    endTime: Number(row.end_time)
  }));
}

function writePredictionsJson(
  outPath: string,
  payload: JsonOutputPayload
) {
  ensureDirForFile(outPath);
  writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
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

  const rootDir = path.resolve(readArg('--root') || '.');
  const midiPath = path.resolve(midiArg);
  const modelPath = path.resolve(readArg('--model') || 'data/ml/model.json');
  const dbPath = path.resolve(readArg('--db') || process.env.JAMCODA_DB_PATH || 'data/jamcoda.db');
  const outPath = readArg('--out') ? path.resolve(readArg('--out')!) : undefined;
  const clearUnpromoted = parseBoolean(readArg('--clear-unpromoted'), true);
  const dryRun = hasFlag('--dry-run');

  const config: PredictConfig = {
    minWindowConfidence: clamp(parseNum(readArg('--min-window-confidence'), 0.45), 0, 1),
    smoothingWindows: Math.max(1, Math.floor(parseNum(readArg('--smoothing'), 5))),
    minSegmentSec: Math.max(0, parseNum(readArg('--min-segment-sec'), 8)),
    minSegmentConfidence: clamp(parseNum(readArg('--min-segment-confidence'), 0.65), 0, 1),
    mergeGapSec: Math.max(0, parseNum(readArg('--merge-gap-sec'), 3))
  };

  const model = loadModel(modelPath);
  const windows = predictWindows(model, midiPath, config);
  const rawSegments = windowsToSegments(windows, {
    minSegmentSec: config.minSegmentSec,
    minSegmentConfidence: config.minSegmentConfidence,
    mergeGapSec: config.mergeGapSec
  });

  ensurePredictionReviewsSchema(dbPath);
  const fileId = resolveFileId(dbPath, rootDir, midiPath);
  const annotationRanges = loadAnnotationRanges(dbPath, fileId);
  const ignoredRanges = loadIgnoredRanges(dbPath, fileId);
  const excludedRanges = [...annotationRanges, ...ignoredRanges];
  const segments = removeExcludedRangesFromSegments(
    rawSegments,
    excludedRanges,
    config.minSegmentSec
  );
  const excludedSegmentCount = Math.max(0, rawSegments.length - segments.length);
  const modelVersion = readArg('--model-version') || `${model.modelType}@${model.createdAt}`;

  if (segments.length === 0) {
    console.log('No confident segments found with current thresholds.');
  } else {
    console.log(`Predicted ${segments.length} segment(s) for file_id=${fileId}:`);
    for (const segment of segments) {
      console.log(
        `  ${segment.songName}`
        + ` | ${segment.startTime.toFixed(1)}s - ${segment.endTime.toFixed(1)}s`
        + ` | conf=${segment.confidence.toFixed(2)}`
      );
    }
  }
  if (annotationRanges.length > 0 || ignoredRanges.length > 0) {
    console.log(
      `Excluded ranges: ${annotationRanges.length} annotated + ${ignoredRanges.length} ignored; `
      + `filtered out ${excludedSegmentCount} segment(s).`
    );
  }

  if (outPath) {
    writePredictionsJson(outPath, {
      generatedAt: new Date().toISOString(),
      midiPath,
      modelPath,
      dbPath,
      fileId,
      config: {
        ...config,
        windowSec: model.config.windowSec,
        stepSec: model.config.stepSec,
        k: model.config.k
      },
      segments
    });
    console.log(`Wrote prediction JSON to ${outPath}`);
  }

  if (dryRun) {
    console.log('Dry run enabled. Skipping DB import.');
    return;
  }

  const statements: string[] = ['BEGIN;'];
  if (clearUnpromoted) {
    statements.push(`
      DELETE FROM prediction_reviews
      WHERE file_id = ${fileId}
        AND promoted_annotation_id IS NULL;
    `);
  }

  if (segments.length > 0) {
    const values = segments.map((segment) => {
      const song = sqlEscape(segment.songName);
      const confidence = Number.isFinite(segment.confidence) ? segment.confidence : 'NULL';
      const start = Number(segment.startTime.toFixed(6));
      const end = Number(segment.endTime.toFixed(6));

      return `(
        ${fileId},
        '${song}',
        ${start},
        ${end},
        ${confidence},
        'unsure',
        NULL,
        NULL,
        NULL,
        NULL,
        '${sqlEscape(modelVersion)}',
        NULL,
        strftime('%s','now'),
        strftime('%s','now'),
        NULL,
        NULL
      )`;
    });

    statements.push(`
      INSERT INTO prediction_reviews (
        file_id,
        predicted_song_name,
        predicted_start_time,
        predicted_end_time,
        predicted_confidence,
        status,
        reviewed_song_name,
        reviewed_start_time,
        reviewed_end_time,
        review_notes,
        model_version,
        promoted_annotation_id,
        created_at,
        updated_at,
        reviewed_at,
        promoted_at
      )
      VALUES ${values.join(',\n')};
    `);
  }

  statements.push('COMMIT;');
  sqliteExec(dbPath, statements.join('\n'));

  console.log(
    `Imported ${segments.length} prediction review row(s) for file_id=${fileId}`
    + `${clearUnpromoted ? ' (cleared previous unpromoted rows first).' : '.'}`
  );
  console.log(`Open #/reviews?fileId=${fileId} to review in the UI.`);
}

main().catch((error) => {
  console.error('Predict/import failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
