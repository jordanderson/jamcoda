import path from 'node:path';
import { existsSync } from 'node:fs';
import * as AnnotationModel from '@models/Annotation';
import * as FileModel from '@models/File';
import * as PredictionReviewModel from '@models/PredictionReview';
import { dbPathFromEnv, resolveStoredMidiPath, toStoredMidiPath } from '@config/library';
import {
  countModifiedSegments,
  removeExcludedRangesFromSegments,
  splitSegmentsAtTimes,
  type TimeRange
} from '@core/timeRanges';
import type { JmxBookmark, JmxSkip } from '@server/types';
import {
  DECODE_ONLY_CONFIG_KEYS,
  extractNotesFromMidi,
  loadAnnotatedMidiFiles,
  loadModel,
  predictWindows,
  refitConfigOf,
  trainModel,
  windowsToSegments,
  type DecodeOnlyConfig,
  type PredictConfig,
  type SongSegment,
  type SongSegmentModel
} from '../../ml/songSegmentation';

/**
 * Run the segmentation model over one file and import the results as
 * prediction reviews.
 *
 * The single implementation of that pipeline. `POST /api/prediction-reviews/run`
 * and `ml:predict-import` both call it, so the exclusion rules, the model
 * version string and the insert shape cannot drift apart.
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
  /**
   * Decoder settings applied on top of the saved model's own config. These
   * never change the trained model, so two runs differing only here are
   * comparable — that is what lets a preview try a decoder setting without
   * rebuilding. Anything absent falls back to what the model was trained with.
   */
  decoderOverrides?: DecodeOnlyConfig;
  /**
   * Predict with a model retrained from the saved model's settings on every
   * annotated file except this one: what the model says about a recording it
   * has never seen. The saved model was trained on this file's annotations, so
   * on an annotated file it largely remembers them. Dry runs only.
   */
  holdOut?: boolean;
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
  /** The decoder settings actually used, after any overrides. */
  decodeConfig: DecodeOnlyConfig;
  /** Whether the segments came from a model retrained without this file. */
  heldOut: boolean;
  segments: SongSegment[];
  /**
   * What the model said before annotated ranges were removed and bookmark and
   * silence splits applied. Only populated for a dry run: on a file that is
   * already annotated every segment is excluded, so the written shape says
   * nothing about the model, and comparing decoder settings needs this.
   */
  rawSegments: SongSegment[];
  /** Segments the model produced before annotated ranges were removed. */
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
export function resolveMidiPath(localPath: string): string {
  const midiPath = resolveStoredMidiPath(localPath);

  if (!existsSync(midiPath)) {
    throw new PredictionImportError(`MIDI file not found on disk: ${midiPath}`, 'not_found');
  }
  return midiPath;
}

/**
 * Find the `files` row for a MIDI path, matching the way the CLI is invoked
 * (a path on disk rather than a file id).
 */
export function findFileIdByMidiPath(midiPathAbs: string): number {
  const stored = toStoredMidiPath(path.resolve(midiPathAbs));
  const match = FileModel.findAll().find((file) => file.local_path === stored);

  if (!match) {
    throw new PredictionImportError(
      `Could not find a files row for MIDI path ${midiPathAbs} (local_path = ${stored})`,
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
    decoderOverrides,
    holdOut = false
  } = options;

  const file = FileModel.findById(fileId);
  if (!file) {
    throw new PredictionImportError(`File ${fileId} not found`, 'not_found');
  }

  // File completion is authoritative. A completed file's annotations are
  // final, so re-running predictions is rejected rather than silently
  // producing rows that can never be promoted. A dry run writes nothing, and a
  // completed file is the only place a prediction can be held against a known
  // answer, so previewing one is allowed.
  if (file.is_complete && !dryRun) {
    throw new PredictionImportError(
      'Cannot run predictions on a file marked complete',
      'invalid'
    );
  }

  if (holdOut && !dryRun) {
    throw new PredictionImportError(
      'A held-out model is for previews only and is never written to the review queue',
      'invalid'
    );
  }

  const midiPath = resolveMidiPath(file.local_path);

  const savedModel = loadModel(modelPath);
  const model = holdOut ? fitHeldOutModel(savedModel, fileId) : savedModel;
  if (decoderOverrides) {
    // Copy key by key rather than spreading. The type says decode-only, but a
    // caller reaching past it must not be able to change how the windows are
    // cut and pass the result off as this model's output.
    for (const key of DECODE_ONLY_CONFIG_KEYS) {
      const value = decoderOverrides[key];
      if (value !== undefined) (model.config[key] as unknown) = value;
    }
  }
  const notes = extractNotesFromMidi(midiPath);
  const windows = predictWindows(model, midiPath, config);
  const rawSegments = windowsToSegments(windows, {
    minSegmentSec: config.minSegmentSec,
    minSegmentConfidence: config.minSegmentConfidence,
    mergeGapSec: config.mergeGapSec
  }, notes);

  const annotatedRanges: TimeRange[] = AnnotationModel.listRangesByFileId(fileId);

  const bookmarks = parseBookmarks(file.bookmarks_json);
  const skips = parseSkips(file.skips_json);

  const excluded = removeExcludedRangesFromSegments(
    rawSegments,
    annotatedRanges,
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

  const modelVersion = options.modelVersion || `${savedModel.modelType}@${savedModel.createdAt}`;

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
          modelVersion,
          predictedParts: segment.parts ?? null
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
    decodeConfig: Object.fromEntries(
      DECODE_ONLY_CONFIG_KEYS
        .filter((key) => model.config[key] !== undefined)
        .map((key) => [key, model.config[key]])
    ),
    heldOut: holdOut,
    segments,
    rawSegments: dryRun ? rawSegments : [],
    rawSegmentCount: rawSegments.length,
    excludedSegmentCount,
    bookmarkSplitCount,
    skipSplitCount,
    bookmarks,
    skips,
    annotatedRangeCount: annotatedRanges.length,
    clearedCount,
    insertedCount,
    dryRun
  };
}

/**
 * Refit `saved` on every annotated file but `fileId`, from the database's
 * current annotations.
 *
 * The refit keeps the saved model's config, so it extracts the same features
 * and decodes the same way. Only fit-time settings the saved model never recorded,
 * other than its features, take today's defaults.
 */
function fitHeldOutModel(saved: SongSegmentModel, fileId: number): SongSegmentModel {
  const files = loadAnnotatedMidiFiles(dbPathFromEnv()).filter((file) => file.fileId !== fileId);
  if (files.length === 0) {
    throw new PredictionImportError('No other annotated file to train a held-out model on', 'invalid');
  }
  const { model } = trainModel(files, refitConfigOf(saved.config));
  return { ...model, config: { ...saved.config } };
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
