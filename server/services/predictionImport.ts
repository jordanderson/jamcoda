import path from 'node:path';
import { existsSync } from 'node:fs';
import * as AnnotationModel from '@models/Annotation';
import * as FileModel from '@models/File';
import * as IgnoredSectionModel from '@models/IgnoredSection';
import * as PredictionReviewModel from '@models/PredictionReview';
import {
  countModifiedSegments,
  removeExcludedRangesFromSegments,
  splitSegmentsAtTimes,
  type TimeRange
} from '@core/timeRanges';
import type { JmxBookmark, JmxSkip } from '@server/types';
import {
  loadModel,
  predictWindows,
  windowsToSegments,
  type PredictConfig,
  type SongSegment
} from '../../ml/songSegmentation';

/**
 * Run the segmentation model over one file and import the results as
 * prediction reviews.
 *
 * This is the single implementation of that pipeline. It previously existed
 * twice -- once in `POST /api/prediction-reviews/run` against the model layer,
 * and once in `ml/predictAndImport.ts` against string-interpolated SQL run
 * through the `sqlite3` CLI, complete with its own `CREATE TABLE IF NOT
 * EXISTS` that was a third source of schema truth beside the migrations. Both
 * callers now come through here, so the exclusion rules, the model version
 * string and the insert shape cannot drift, and the CLI no longer needs the
 * `sqlite3` binary.
 */

export interface RunPredictionOptions {
  fileId: number;
  modelPath: string;
  config: PredictConfig;
  /** Remove existing not-yet-promoted reviews for the file first. */
  clearUnpromoted?: boolean;
  /** Override the recorded model version; defaults to `<modelType>@<createdAt>`. */
  modelVersion?: string;
  /** Compute segments without writing anything. */
  dryRun?: boolean;
  /** Root used to resolve the file's relative `local_path`. */
  rootDir?: string;
  /**
   * Only silence gaps (`jmxSkip.millis`) at or above this many seconds become
   * boundary split hints (default 30). Bookmarks always split; silence gaps
   * are noisier, so short gaps are ignored.
   */
  minSkipSplitSec?: number;
}

export interface RunPredictionResult {
  fileId: number;
  filename: string;
  midiPath: string;
  modelVersion: string;
  config: PredictConfig;
  modelConfig: { windowSec: number; stepSec: number; k: number };
  segments: SongSegment[];
  /** Segments the model produced before annotated/ignored ranges were removed. */
  rawSegmentCount: number;
  /** Segments dropped or trimmed by exclusion. */
  excludedSegmentCount: number;
  /** Segments split or dropped because a device bookmark cut through them. */
  bookmarkSplitCount: number;
  /** Segments split or dropped because a large silence gap cut through them. */
  skipSplitCount: number;
  /** Passage markers parsed from the file's JMX trailer. */
  bookmarks: JmxBookmark[];
  /** Silence gaps parsed from the file's JMX trailer. */
  skips: JmxSkip[];
  annotatedRangeCount: number;
  ignoredRangeCount: number;
  clearedCount: number;
  insertedCount: number;
  dryRun: boolean;
}

export class PredictionImportError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'invalid') {
    super(message);
    this.name = 'PredictionImportError';
  }
}

/** Resolve a file's MIDI path on disk, or throw a caller-friendly error. */
export function resolveMidiPath(localPath: string, rootDir = process.cwd()): string {
  const midiPath = path.isAbsolute(localPath)
    ? localPath
    : path.resolve(rootDir, localPath);

  if (!existsSync(midiPath)) {
    throw new PredictionImportError(`MIDI file not found on disk: ${midiPath}`, 'not_found');
  }
  return midiPath;
}

/**
 * Find the `files` row for a MIDI path, matching the way the CLI is invoked
 * (an absolute or repo-relative path rather than a file id).
 */
export function findFileIdByMidiPath(midiPathAbs: string, rootDir = process.cwd()): number {
  const relative = path.relative(rootDir, midiPathAbs).split(path.sep).join('/');
  const absolute = midiPathAbs.split(path.sep).join('/');

  const match = FileModel.findAll().find(
    (file) => file.local_path === relative || file.local_path === absolute
  );

  if (!match) {
    throw new PredictionImportError(
      `Could not find a files row for MIDI path.\nTried local_path = ${relative} and ${absolute}`,
      'not_found'
    );
  }
  return match.id;
}

export function runPredictionImport(options: RunPredictionOptions): RunPredictionResult {
  const {
    fileId,
    modelPath,
    config,
    clearUnpromoted = true,
    dryRun = false,
    rootDir = process.cwd()
  } = options;

  const file = FileModel.findById(fileId);
  if (!file) {
    throw new PredictionImportError(`File ${fileId} not found`, 'not_found');
  }

  // File completion is authoritative: a completed file's annotations are
  // final, so re-running predictions over it is rejected rather than silently
  // producing rows that can never be promoted.
  if (file.is_complete) {
    throw new PredictionImportError(
      'Cannot run predictions on a file marked complete',
      'invalid'
    );
  }

  const midiPath = resolveMidiPath(file.local_path, rootDir);

  const model = loadModel(modelPath);
  const windows = predictWindows(model, midiPath, config);
  const rawSegments = windowsToSegments(windows, {
    minSegmentSec: config.minSegmentSec,
    minSegmentConfidence: config.minSegmentConfidence,
    mergeGapSec: config.mergeGapSec
  });

  const annotatedRanges: TimeRange[] = AnnotationModel.listRangesByFileId(fileId);
  const ignoredRanges: TimeRange[] = IgnoredSectionModel.listRangesByFileId(fileId);

  const bookmarks = parseBookmarks(file.bookmarks_json);
  const skips = parseSkips(file.skips_json);

  const excluded = removeExcludedRangesFromSegments(
    rawSegments,
    [...annotatedRanges, ...ignoredRanges],
    config.minSegmentSec
  );
  const excludedSegmentCount = countModifiedSegments(rawSegments, excluded);

  const bookmarkTimes = bookmarks.map((bookmark) => bookmark.timeSec);
  const bookmarkSplitSegments = splitSegmentsAtTimes(
    excluded,
    bookmarkTimes,
    config.minSegmentSec
  );
  const bookmarkSplitCount = countModifiedSegments(excluded, bookmarkSplitSegments);

  // Silence gaps are only hints for large pauses; short gaps (breathing,
  // page turns) occur inside songs and would over-fragment if split.
  const minSkipSplitSec = Math.max(0, options.minSkipSplitSec ?? 30);
  const skipTimes = skips
    .filter((skip) => skip.millis >= minSkipSplitSec * 1000)
    .map((skip) => skip.timeSec);
  const skipSplitSegments = splitSegmentsAtTimes(
    bookmarkSplitSegments,
    skipTimes,
    config.minSegmentSec
  );
  const skipSplitCount = countModifiedSegments(bookmarkSplitSegments, skipSplitSegments);
  const segments = skipSplitSegments;

  const modelVersion = options.modelVersion || `${model.modelType}@${model.createdAt}`;

  let clearedCount = 0;
  let insertedCount = 0;

  if (!dryRun) {
    if (clearUnpromoted) {
      clearedCount = PredictionReviewModel.deleteUnpromotedByFileId(fileId);
    }

    if (segments.length > 0) {
      insertedCount = PredictionReviewModel.createMany(
        segments.map((segment) => ({
          fileId,
          predictedSongName: segment.songName,
          predictedStartTime: segment.startTime,
          predictedEndTime: segment.endTime,
          predictedConfidence: segment.confidence,
          status: 'unsure' as const,
          modelVersion
        }))
      ).length;
    }
  }

  return {
    fileId,
    filename: file.filename,
    midiPath,
    modelVersion,
    config,
    modelConfig: {
      windowSec: model.config.windowSec,
      stepSec: model.config.stepSec,
      k: model.config.k
    },
    segments,
    rawSegmentCount: rawSegments.length,
    excludedSegmentCount,
    bookmarkSplitCount,
    skipSplitCount,
    bookmarks,
    skips,
    annotatedRangeCount: annotatedRanges.length,
    ignoredRangeCount: ignoredRanges.length,
    clearedCount,
    insertedCount,
    dryRun
  };
}

function parseBookmarks(bookmarksJson: string | null | undefined): JmxBookmark[] {
  if (!bookmarksJson) return [];
  try {
    const parsed = JSON.parse(bookmarksJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is JmxBookmark =>
        entry
        && typeof entry === 'object'
        && typeof (entry as JmxBookmark).bookmarkIdx === 'number'
        && typeof (entry as JmxBookmark).timeSec === 'number'
    );
  } catch {
    return [];
  }
}

function parseSkips(skipsJson: string | null | undefined): JmxSkip[] {
  if (!skipsJson) return [];
  try {
    const parsed = JSON.parse(skipsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is JmxSkip =>
        entry
        && typeof entry === 'object'
        && typeof (entry as JmxSkip).millis === 'number'
        && typeof (entry as JmxSkip).timeSec === 'number'
    );
  } catch {
    return [];
  }
}
