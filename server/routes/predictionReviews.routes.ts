import express from 'express';
import type { Request, Response } from 'express';
import * as PredictionReviewModel from '@models/PredictionReview';
import type { PredictionReviewStatus } from '@server/types';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { clamp } from '@core/cli/args';
import {
  PredictionImportError,
  runPredictionImport
} from '../services/predictionImport';
import {
  evaluateLeaveOneOut,
  loadAnnotatedMidiFiles,
  saveModel,
  trainModel,
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

function parseOptionalScaling(value: unknown): TrainConfig['featureScaling'] {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'zscore' || normalized === 'minmax' || normalized === 'none') {
      return normalized;
    }
  }
  return undefined;
}

function parseOptionalScoreMode(value: unknown): TrainConfig['scoreMode'] {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'min' || normalized === 'avg') return normalized;
  }
  return undefined;
}

function parseOptionalDecoder(value: unknown): TrainConfig['decoder'] {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'anchor' || normalized === 'viterbi' || normalized === 'smooth') {
      return normalized;
    }
  }
  return undefined;
}

function isValidTimeRange(start: number, end: number): boolean {
  return Number.isFinite(start) && Number.isFinite(end) && start < end;
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

    const projectRoot = process.cwd();

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
      minSegmentConfidence: clamp(parseOptionalNumber(req.body.minSegmentConfidence) ?? 0.3, 0, 1),
      mergeGapSec: Math.max(0, parseOptionalNumber(req.body.mergeGapSec) ?? 3)
    };
    const clearUnpromoted = parseOptionalBoolean(req.body.clearUnpromoted) ?? true;
    const minSkipSplitSec = Math.max(0, parseOptionalNumber(req.body.minSkipSplitSec) ?? 30);

    const result = runPredictionImport({
      fileId,
      modelPath,
      config,
      clearUnpromoted,
      minSkipSplitSec,
      rootDir: projectRoot
    });

    res.json({
      fileId: result.fileId,
      filename: result.filename,
      modelVersion: result.modelVersion,
      config: result.config,
      clearUnpromoted,
      clearedCount: result.clearedCount,
      insertedCount: result.insertedCount,
      segmentCount: result.segments.length,
      annotatedRangeCount: result.annotatedRangeCount,
      ignoredRangeCount: result.ignoredRangeCount,
      excludedSegmentCount: result.excludedSegmentCount,
      bookmarkSplitCount: result.bookmarkSplitCount,
      bookmarkCount: result.bookmarks.length,
      skipSplitCount: result.skipSplitCount,
      skipCount: result.skips.length
    });
  } catch (error) {
    if (error instanceof PredictionImportError) {
      return res
        .status(error.code === 'not_found' ? 404 : 400)
        .json({ error: error.message });
    }
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
      maxNoneToSongRatio: Math.max(0, parseOptionalNumber(req.body.maxNoneToSongRatio) ?? 1.5),
      prototypeBudget: Math.max(1, Math.floor(parseOptionalNumber(req.body.prototypeBudget) ?? 1200)),
      maxNonePrototypes: Math.max(1, Math.floor(parseOptionalNumber(req.body.maxNonePrototypes) ?? 120)),
      featureScaling: parseOptionalScaling(req.body.featureScaling),
      scoreMode: parseOptionalScoreMode(req.body.scoreMode),
      decoder: parseOptionalDecoder(req.body.decoder),
      anchorMargin: Math.max(0, parseOptionalNumber(req.body.anchorMargin) ?? 0.15),
      minAnchorRun: Math.max(1, Math.floor(parseOptionalNumber(req.body.minAnchorRun) ?? 3)),
      fillTopK: parseOptionalNumber(req.body.fillTopK) ?? -1
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
