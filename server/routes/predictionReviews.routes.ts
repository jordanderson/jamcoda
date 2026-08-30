import express from 'express';
import type { Request, Response } from 'express';
import * as PredictionReviewModel from '@models/PredictionReview';
import * as FileModel from '@models/File';
import * as AnnotationModel from '@models/Annotation';
import * as IgnoredSectionModel from '@models/IgnoredSection';
import type { PredictionReviewStatus } from '@server/types';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  evaluateLeaveOneOut,
  loadAnnotatedMidiFiles,
  loadModel,
  predictWindows,
  saveModel,
  trainModel,
  windowsToSegments,
  type SongSegment,
  type PredictConfig,
  type TrainConfig
} from '../../ml/songSegmentation';

const router = express.Router();

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  return Number(value);
}

function parseOptionalInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = Number(value);
  if (!Number.isInteger(num)) return undefined;
  return num;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return num;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isValidTimeRange(start: number, end: number): boolean {
  return Number.isFinite(start) && Number.isFinite(end) && start < end;
}

interface TimeRange {
  startTime: number;
  endTime: number;
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
  segments: SongSegment[],
  excludedRanges: TimeRange[],
  minSegmentSec: number
): SongSegment[] {
  if (segments.length === 0 || excludedRanges.length === 0) {
    return segments;
  }

  const normalizedExcluded = normalizeRanges(excludedRanges);
  if (normalizedExcluded.length === 0) {
    return segments;
  }

  const kept: SongSegment[] = [];

  for (const segment of segments) {
    let cursor = segment.startTime;
    for (const excluded of normalizedExcluded) {
      if (excluded.endTime <= cursor) {
        continue;
      }
      if (excluded.startTime >= segment.endTime) {
        break;
      }

      const keptEnd = Math.min(excluded.startTime, segment.endTime);
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

      cursor = Math.max(cursor, excluded.endTime);
      if (cursor >= segment.endTime) {
        break;
      }
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

function parseSongName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalReviewedSongName(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return parseSongName(value);
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const fileId = parseOptionalInt(req.query.fileId);
    const statusRaw = req.query.status as string | undefined;
    const includePromoted = parseOptionalBoolean(req.query.includePromoted) ?? true;
    const limit = Math.min(500, Math.max(1, parseOptionalInt(req.query.limit) ?? 100));
    const offset = Math.max(0, parseOptionalInt(req.query.offset) ?? 0);

    if (statusRaw !== undefined && !PredictionReviewModel.isPredictionReviewStatus(statusRaw)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }
    const status = statusRaw as PredictionReviewStatus | undefined;

    const filters = {
      fileId,
      status,
      includePromoted,
      limit,
      offset
    };

    const reviews = PredictionReviewModel.list(filters);
    const total = PredictionReviewModel.count(filters);

    res.json({
      reviews,
      total,
      limit,
      offset
    });
  } catch (error) {
    console.error('Error listing prediction reviews:', error);
    res.status(500).json({ error: 'Failed to list prediction reviews' });
  }
});

router.get('/queue', async (req: Request, res: Response) => {
  try {
    const fileId = parseOptionalInt(req.query.fileId);
    const limit = Math.min(500, Math.max(1, parseOptionalInt(req.query.limit) ?? 50));
    const reviews = PredictionReviewModel.getReviewQueue(limit, fileId);
    res.json({ reviews, limit });
  } catch (error) {
    console.error('Error getting prediction review queue:', error);
    res.status(500).json({ error: 'Failed to get prediction review queue' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      fileId,
      predictedSongName,
      predictedStartTime,
      predictedEndTime,
      predictedConfidence,
      status,
      reviewedSongName,
      reviewedStartTime,
      reviewedEndTime,
      reviewNotes,
      modelVersion
    } = req.body;

    const parsedFileId = parseOptionalInt(fileId);
    const parsedSongName = parseSongName(predictedSongName);
    const parsedStart = toNumber(predictedStartTime);
    const parsedEnd = toNumber(predictedEndTime);
    const parsedConfidence = predictedConfidence === undefined || predictedConfidence === null
      ? null
      : toNumber(predictedConfidence);

    if (!parsedFileId || !parsedSongName || !isValidTimeRange(parsedStart, parsedEnd)) {
      return res.status(400).json({ error: 'Invalid required prediction fields' });
    }

    if (parsedConfidence !== null && (!Number.isFinite(parsedConfidence) || parsedConfidence < 0 || parsedConfidence > 1)) {
      return res.status(400).json({ error: 'predictedConfidence must be between 0 and 1' });
    }

    if (status !== undefined && !PredictionReviewModel.isPredictionReviewStatus(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }
    const parsedStatus = status as PredictionReviewStatus | undefined;

    if (reviewedStartTime !== undefined && reviewedEndTime !== undefined) {
      const parsedReviewedStart = reviewedStartTime === null ? null : toNumber(reviewedStartTime);
      const parsedReviewedEnd = reviewedEndTime === null ? null : toNumber(reviewedEndTime);
      if (parsedReviewedStart !== null && parsedReviewedEnd !== null && !isValidTimeRange(parsedReviewedStart, parsedReviewedEnd)) {
        return res.status(400).json({ error: 'Invalid reviewed time range' });
      }
    }

    const parsedReviewedSongName = parseOptionalReviewedSongName(reviewedSongName);
    if (reviewedSongName !== undefined && reviewedSongName !== null && !parsedReviewedSongName) {
      return res.status(400).json({ error: 'reviewedSongName must be a non-empty string or null' });
    }

    const id = PredictionReviewModel.create({
      fileId: parsedFileId,
      predictedSongName: parsedSongName,
      predictedStartTime: parsedStart,
      predictedEndTime: parsedEnd,
      predictedConfidence: parsedConfidence,
      status: parsedStatus,
      reviewedSongName: parsedReviewedSongName,
      reviewedStartTime: reviewedStartTime === undefined ? undefined : (reviewedStartTime === null ? null : toNumber(reviewedStartTime)),
      reviewedEndTime: reviewedEndTime === undefined ? undefined : (reviewedEndTime === null ? null : toNumber(reviewedEndTime)),
      reviewNotes,
      modelVersion
    });

    const review = PredictionReviewModel.findById(id);
    res.status(201).json(review);
  } catch (error) {
    console.error('Error creating prediction review:', error);
    res.status(500).json({ error: 'Failed to create prediction review' });
  }
});

router.post('/bulk', async (req: Request, res: Response) => {
  try {
    const fileId = parseOptionalInt(req.body.fileId);
    const modelVersion = req.body.modelVersion as string | undefined;
    const predictions = Array.isArray(req.body.predictions) ? req.body.predictions : null;

    if (!fileId || !predictions || predictions.length === 0) {
      return res.status(400).json({ error: 'fileId and non-empty predictions array are required' });
    }

    const payloads = predictions.map((prediction: Record<string, unknown>, idx: number) => {
      const predictedSongName = parseSongName(prediction.predictedSongName ?? prediction.songName);
      const predictedStartTime = toNumber(prediction.predictedStartTime ?? prediction.startTime);
      const predictedEndTime = toNumber(prediction.predictedEndTime ?? prediction.endTime);
      const predictedConfidence = prediction.predictedConfidence ?? prediction.confidence ?? null;
      const status = prediction.status as string | undefined;

      if (!predictedSongName || !isValidTimeRange(predictedStartTime, predictedEndTime)) {
        throw new Error(`Invalid prediction at index ${idx}`);
      }

      const parsedConfidence = predictedConfidence === null ? null : toNumber(predictedConfidence);
      if (parsedConfidence !== null && (!Number.isFinite(parsedConfidence) || parsedConfidence < 0 || parsedConfidence > 1)) {
        throw new Error(`Invalid confidence at index ${idx}`);
      }

      if (status !== undefined && !PredictionReviewModel.isPredictionReviewStatus(status)) {
        throw new Error(`Invalid status at index ${idx}`);
      }

      return {
        fileId,
        predictedSongName,
        predictedStartTime,
        predictedEndTime,
        predictedConfidence: parsedConfidence,
        status: status as PredictionReviewStatus | undefined,
        modelVersion
      };
    });

    const ids = PredictionReviewModel.createMany(payloads);
    res.status(201).json({ created: ids.length, ids });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create prediction reviews';
    console.error('Error creating prediction reviews in bulk:', error);
    res.status(400).json({ error: message });
  }
});

router.post('/merge', async (req: Request, res: Response) => {
  try {
    const reviewIdsRaw = Array.isArray(req.body.reviewIds) ? req.body.reviewIds : null;
    if (!reviewIdsRaw || reviewIdsRaw.length < 2) {
      return res.status(400).json({ error: 'reviewIds must contain at least 2 IDs' });
    }

    const reviewIds: number[] = [];
    for (const value of reviewIdsRaw) {
      const id = parseOptionalInt(value);
      if (!id) {
        return res.status(400).json({ error: 'reviewIds must contain valid integer IDs' });
      }
      reviewIds.push(id);
    }

    const result = PredictionReviewModel.mergeReviews(reviewIds);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to merge prediction reviews';
    if (
      message.includes('Select at least')
      || message.includes('not found')
      || message.includes('same file')
      || message.includes('same song')
      || message.includes('already promoted')
      || message.includes('invalid time range')
    ) {
      return res.status(400).json({ error: message });
    }

    console.error('Error merging prediction reviews:', error);
    res.status(500).json({ error: 'Failed to merge prediction reviews' });
  }
});

router.post('/promote-reviewed', async (req: Request, res: Response) => {
  try {
    const fileId = parseOptionalInt(req.body.fileId);
    const limit = Math.min(500, Math.max(1, parseOptionalInt(req.body.limit) ?? 100));
    const promotable = PredictionReviewModel.listPromotableUnpromoted(limit, fileId);

    const promoted: Array<{ reviewId: number; annotationId: number; created: boolean }> = [];
    const failed: Array<{ reviewId: number; error: string }> = [];

    for (const review of promotable) {
      try {
        const result = PredictionReviewModel.promoteToAnnotation(review.id);
        promoted.push({
          reviewId: review.id,
          annotationId: result.annotationId,
          created: result.created
        });
      } catch (error) {
        failed.push({
          reviewId: review.id,
          error: error instanceof Error ? error.message : 'Promotion failed'
        });
      }
    }

    res.json({
      attempted: promotable.length,
      promoted,
      failed
    });
  } catch (error) {
    console.error('Error promoting reviewed predictions:', error);
    res.status(500).json({ error: 'Failed to promote reviewed predictions' });
  }
});

router.post('/run', async (req: Request, res: Response) => {
  try {
    const fileId = parseOptionalInt(req.body.fileId);
    if (!fileId) {
      return res.status(400).json({ error: 'fileId is required' });
    }

    const file = FileModel.findById(fileId);
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (file.is_complete === 1) {
      return res.status(400).json({
        error: 'File is marked complete. Mark it incomplete to run predictions.'
      });
    }

    const projectRoot = process.cwd();
    const midiPath = path.isAbsolute(file.local_path)
      ? file.local_path
      : path.resolve(projectRoot, file.local_path);
    if (!existsSync(midiPath)) {
      return res.status(400).json({
        error: `MIDI file does not exist on disk: ${midiPath}`
      });
    }

    const modelPathArg = typeof req.body.modelPath === 'string' && req.body.modelPath.trim().length > 0
      ? req.body.modelPath.trim()
      : 'data/ml/model.json';
    const modelPath = path.isAbsolute(modelPathArg)
      ? modelPathArg
      : path.resolve(projectRoot, modelPathArg);
    if (!existsSync(modelPath)) {
      return res.status(400).json({
        error: `Model file does not exist: ${modelPath}`
      });
    }

    const config: PredictConfig = {
      minWindowConfidence: clamp(parseOptionalNumber(req.body.minWindowConfidence) ?? 0.45, 0, 1),
      smoothingWindows: Math.max(1, Math.floor(parseOptionalNumber(req.body.smoothingWindows) ?? 5)),
      minSegmentSec: Math.max(0, parseOptionalNumber(req.body.minSegmentSec) ?? 8),
      minSegmentConfidence: clamp(parseOptionalNumber(req.body.minSegmentConfidence) ?? 0.65, 0, 1),
      mergeGapSec: Math.max(0, parseOptionalNumber(req.body.mergeGapSec) ?? 3)
    };
    const clearUnpromoted = parseOptionalBoolean(req.body.clearUnpromoted) ?? true;

    const model = loadModel(modelPath);
    const windows = predictWindows(model, midiPath, config);
    const rawSegments = windowsToSegments(windows, {
      minSegmentSec: config.minSegmentSec,
      minSegmentConfidence: config.minSegmentConfidence,
      mergeGapSec: config.mergeGapSec
    });
    const annotatedRanges = AnnotationModel.listRangesByFileId(fileId);
    const ignoredRanges = IgnoredSectionModel.listRangesByFileId(fileId);
    const excludedRanges = [...annotatedRanges, ...ignoredRanges];
    const segments = removeExcludedRangesFromSegments(
      rawSegments,
      excludedRanges,
      config.minSegmentSec
    );
    const excludedSegmentCount = Math.max(0, rawSegments.length - segments.length);

    const clearedCount = clearUnpromoted
      ? PredictionReviewModel.deleteUnpromotedByFileId(fileId)
      : 0;

    const modelVersion = `${model.modelType}@${model.createdAt}`;
    const createdIds = segments.length > 0
      ? PredictionReviewModel.createMany(
        segments.map((segment) => ({
          fileId,
          predictedSongName: segment.songName,
          predictedStartTime: segment.startTime,
          predictedEndTime: segment.endTime,
          predictedConfidence: segment.confidence,
          status: 'unsure',
          modelVersion
        }))
      )
      : [];

    res.json({
      fileId,
      filename: file.filename,
      modelVersion,
      config,
      clearUnpromoted,
      clearedCount,
      insertedCount: createdIds.length,
      segmentCount: segments.length,
      annotatedRangeCount: annotatedRanges.length,
      ignoredRangeCount: ignoredRanges.length,
      excludedSegmentCount,
      ignoredSegmentCount: excludedSegmentCount
    });
  } catch (error) {
    console.error('Error running predictions for file:', error);
    res.status(500).json({ error: 'Failed to run predictions for file' });
  }
});

router.post('/rebuild-model', async (req: Request, res: Response) => {
  try {
    const projectRoot = process.cwd();
    const rootDirArg = typeof req.body.rootDir === 'string' && req.body.rootDir.trim().length > 0
      ? req.body.rootDir.trim()
      : projectRoot;
    const rootDir = path.isAbsolute(rootDirArg)
      ? rootDirArg
      : path.resolve(projectRoot, rootDirArg);

    const dbPathArg = typeof req.body.dbPath === 'string' && req.body.dbPath.trim().length > 0
      ? req.body.dbPath.trim()
      : process.env.JAMCODA_DB_PATH || 'data/jamcoda.db';
    const dbPath = path.isAbsolute(dbPathArg)
      ? dbPathArg
      : path.resolve(projectRoot, dbPathArg);
    if (!existsSync(dbPath)) {
      return res.status(400).json({ error: `Database file does not exist: ${dbPath}` });
    }

    const modelPathArg = typeof req.body.modelPath === 'string' && req.body.modelPath.trim().length > 0
      ? req.body.modelPath.trim()
      : 'data/ml/model.json';
    const modelPath = path.isAbsolute(modelPathArg)
      ? modelPathArg
      : path.resolve(projectRoot, modelPathArg);

    const config: TrainConfig = {
      windowSec: parseOptionalNumber(req.body.windowSec) ?? 4,
      stepSec: parseOptionalNumber(req.body.stepSec) ?? 1,
      k: Math.max(1, Math.floor(parseOptionalNumber(req.body.k) ?? 7)),
      maxNoneToSongRatio: Math.max(0, parseOptionalNumber(req.body.maxNoneToSongRatio) ?? 1.5)
    };
    const includeEvaluation = parseOptionalBoolean(req.body.includeEvaluation) ?? false;

    if (!(config.windowSec > 0 && config.stepSec > 0)) {
      return res.status(400).json({ error: 'windowSec and stepSec must be > 0' });
    }

    const files = loadAnnotatedMidiFiles(dbPath, rootDir);
    if (files.length < 2) {
      return res.status(400).json({
        error: `Need at least 2 annotated files to train robustly. Found ${files.length}.`
      });
    }

    const annotationCount = files.reduce((sum, file) => sum + file.annotations.length, 0);
    const { model, samplesByFile } = trainModel(files, config);
    saveModel(model, modelPath);

    let evaluation:
      | {
        folds: number;
        meanOverallAccuracy: number;
        meanSongAccuracy: number;
      }
      | null = null;
    if (includeEvaluation) {
      const evalResult = evaluateLeaveOneOut(files, config, samplesByFile);
      evaluation = {
        folds: evalResult.folds.length,
        meanOverallAccuracy: evalResult.meanOverallAccuracy,
        meanSongAccuracy: evalResult.meanSongAccuracy
      };
    }

    res.json({
      modelPath,
      modelVersion: `${model.modelType}@${model.createdAt}`,
      config,
      filesUsed: files.length,
      annotationsUsed: annotationCount,
      trainingSummary: model.trainingSummary,
      labels: model.labels,
      evaluation
    });
  } catch (error) {
    console.error('Error rebuilding model:', error);
    res.status(500).json({ error: 'Failed to rebuild model' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseOptionalInt(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid review id' });
    }

    const review = PredictionReviewModel.findById(id);
    if (!review) {
      return res.status(404).json({ error: 'Prediction review not found' });
    }
    res.json(review);
  } catch (error) {
    console.error('Error getting prediction review:', error);
    res.status(500).json({ error: 'Failed to get prediction review' });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseOptionalInt(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid review id' });
    }

    const {
      status,
      reviewedSongName,
      reviewedStartTime,
      reviewedEndTime,
      reviewNotes,
      modelVersion
    } = req.body;

    if (status !== undefined && !PredictionReviewModel.isPredictionReviewStatus(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    if (reviewedStartTime !== undefined && reviewedEndTime !== undefined) {
      const parsedReviewedStart = reviewedStartTime === null ? null : toNumber(reviewedStartTime);
      const parsedReviewedEnd = reviewedEndTime === null ? null : toNumber(reviewedEndTime);
      if (parsedReviewedStart !== null && parsedReviewedEnd !== null && !isValidTimeRange(parsedReviewedStart, parsedReviewedEnd)) {
        return res.status(400).json({ error: 'Invalid reviewed time range' });
      }
    }

    const parsedStatus = status as PredictionReviewStatus | undefined;
    const parsedReviewedSongName = parseOptionalReviewedSongName(reviewedSongName);
    if (reviewedSongName !== undefined && reviewedSongName !== null && !parsedReviewedSongName) {
      return res.status(400).json({ error: 'reviewedSongName must be a non-empty string or null' });
    }

    const success = PredictionReviewModel.update(id, {
      status: parsedStatus,
      reviewedSongName: parsedReviewedSongName,
      reviewedStartTime: reviewedStartTime === undefined ? undefined : (reviewedStartTime === null ? null : toNumber(reviewedStartTime)),
      reviewedEndTime: reviewedEndTime === undefined ? undefined : (reviewedEndTime === null ? null : toNumber(reviewedEndTime)),
      reviewNotes,
      modelVersion
    });

    if (!success) {
      return res.status(404).json({ error: 'Prediction review not found' });
    }

    const review = PredictionReviewModel.findById(id);
    res.json(review);
  } catch (error) {
    console.error('Error updating prediction review:', error);
    res.status(500).json({ error: 'Failed to update prediction review' });
  }
});

router.post('/:id/promote', async (req: Request, res: Response) => {
  try {
    const id = parseOptionalInt(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid review id' });
    }

    const result = PredictionReviewModel.promoteToAnnotation(id);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to promote prediction review';
    if (message.includes('not found')) {
      return res.status(404).json({ error: message });
    }
    if (message.includes('Only confirmed or edited') || message.includes('invalid time range')) {
      return res.status(400).json({ error: message });
    }

    console.error('Error promoting prediction review:', error);
    res.status(500).json({ error: 'Failed to promote prediction review' });
  }
});

export default router;
