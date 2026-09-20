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
import { getRebuildStatus } from '../services/rebuildStatus';
import {
  DECODE_ONLY_CONFIG_KEYS,
  evaluateLeaveOneOut,
  loadAnnotatedMidiFiles,
  saveModel,
  trainModel,
  TRAIN_CONFIG_DEFAULTS,
  type DecodeOnlyConfig,
  type PredictConfig,
  type TrainConfig
} from '../../ml/songSegmentation';
import { route } from '@utils/route';
import { errorMessage } from '@core/errors';
import { parseOptionalBoolean, parseOptionalInt, parseOptionalNumber, parseSongName } from '@utils/requestParams';

const router = express.Router();

const DEFAULT_PREDICT_CONFIG: PredictConfig = {
  minWindowConfidence: 0.45,
  smoothingWindows: 5,
  minSegmentSec: 8,
  minSegmentConfidence: 0.3,
  mergeGapSec: 5
};

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  return Number(value);
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

function parseOptionalLinkPolicy(value: unknown): TrainConfig['linkPolicy'] {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'legacy' || normalized === 'bridge') return normalized;
  }
  return undefined;
}

/**
 * Decoder settings a caller may apply on top of the saved model's config.
 *
 * Only decode-only fields are accepted: they re-decode the same trained model,
 * so a preview cannot silently produce segments from a model that was never
 * built. Unknown or malformed values are dropped rather than rejected, matching
 * the rest of this route.
 */
function parseDecoderOverrides(value: unknown): DecodeOnlyConfig | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const body = value as Record<string, unknown>;
  const overrides: Record<string, unknown> = {};
  for (const key of DECODE_ONLY_CONFIG_KEYS) {
    if (!(key in body) || body[key] === undefined || body[key] === null || body[key] === '') continue;
    if (key === 'decoder') {
      const parsed = parseOptionalDecoder(body[key]);
      if (parsed) overrides[key] = parsed;
    } else if (key === 'linkPolicy') {
      const parsed = parseOptionalLinkPolicy(body[key]);
      if (parsed) overrides[key] = parsed;
    } else if (key === 'anchorGapPolicy') {
      const raw = typeof body[key] === 'string' ? (body[key] as string).trim().toLowerCase() : '';
      if (raw === 'legacy' || raw === 'midpoint' || raw === 'evidence') overrides[key] = raw;
    } else {
      const parsed = parseOptionalNumber(body[key]);
      if (parsed !== undefined) overrides[key] = parsed;
    }
  }
  return Object.keys(overrides).length > 0 ? (overrides as DecodeOnlyConfig) : undefined;
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

function parseOptionalReviewedSongName(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return parseSongName(value);
}

router.get('/', route('list prediction reviews', async (req: Request, res: Response) => {
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
}));

router.get('/queue', route('get prediction review queue', async (req: Request, res: Response) => {
  const fileId = parseOptionalInt(req.query.fileId);
  const limit = Math.min(500, Math.max(1, parseOptionalInt(req.query.limit) ?? 50));
  const reviews = PredictionReviewModel.getReviewQueue(limit, fileId);
  res.json({ reviews, limit });
}));

router.post('/', route('create prediction review', async (req: Request, res: Response) => {
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
}));

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
    const message = errorMessage(error, 'Failed to create prediction reviews');
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
    const message = errorMessage(error, 'Failed to merge prediction reviews');
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

router.post('/promote-reviewed', route('promote reviewed predictions', async (req: Request, res: Response) => {
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
        error: errorMessage(error, 'Promotion failed')
      });
    }
  }

  res.json({
    attempted: promotable.length,
    promoted,
    failed
  });
}));

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
      minWindowConfidence: clamp(parseOptionalNumber(req.body.minWindowConfidence) ?? DEFAULT_PREDICT_CONFIG.minWindowConfidence, 0, 1),
      smoothingWindows: Math.max(1, Math.floor(parseOptionalNumber(req.body.smoothingWindows) ?? DEFAULT_PREDICT_CONFIG.smoothingWindows)),
      minSegmentSec: Math.max(0, parseOptionalNumber(req.body.minSegmentSec) ?? DEFAULT_PREDICT_CONFIG.minSegmentSec),
      minSegmentConfidence: clamp(parseOptionalNumber(req.body.minSegmentConfidence) ?? DEFAULT_PREDICT_CONFIG.minSegmentConfidence, 0, 1),
      mergeGapSec: Math.max(0, parseOptionalNumber(req.body.mergeGapSec) ?? DEFAULT_PREDICT_CONFIG.mergeGapSec)
    };
    const clearUnpromoted = parseOptionalBoolean(req.body.clearUnpromoted) ?? true;
    const minSkipSplitSec = Math.max(0, parseOptionalNumber(req.body.minSkipSplitSec) ?? 30);
    // A dry run writes nothing, so it is also allowed on a completed file —
    // the only place a prediction can be held against a known answer.
    const dryRun = parseOptionalBoolean(req.body.dryRun) ?? false;

    const result = runPredictionImport({
      fileId,
      modelPath,
      config,
      clearUnpromoted,
      minSkipSplitSec,
      dryRun,
      decoderOverrides: parseDecoderOverrides(req.body.decoderOverrides),
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
      excludedSegmentCount: result.excludedSegmentCount,
      bookmarkSplitCount: result.bookmarkSplitCount,
      bookmarkCount: result.bookmarks.length,
      skipSplitCount: result.skipSplitCount,
      skipCount: result.skips.length,
      dryRun: result.dryRun,
      decodeConfig: result.decodeConfig,
      // Only a preview needs the segments themselves; a committed run has
      // already written them and the client refetches the review rows.
      segments: result.dryRun ? result.segments : undefined,
      rawSegments: result.dryRun ? result.rawSegments : undefined
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

router.post('/rebuild-model', route('rebuild model', async (req: Request, res: Response) => {
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

  // Anything the request does not set is left undefined so that
  // `resolveTrainConfig` supplies it. Repeating the defaults here is how this
  // route drifted from `ml:train` and trained a different model than the CLI.
  const optionalNumber = (value: unknown, minimum: number, round = false) => {
    const parsed = parseOptionalNumber(value);
    if (parsed === undefined) return undefined;
    return round ? Math.max(minimum, Math.floor(parsed)) : Math.max(minimum, parsed);
  };
  const optionalClamped = (value: unknown, minimum: number, maximum: number) => {
    const parsed = parseOptionalNumber(value);
    return parsed === undefined ? undefined : clamp(parsed, minimum, maximum);
  };
  const config: TrainConfig = {
    windowSec: parseOptionalNumber(req.body.windowSec) ?? TRAIN_CONFIG_DEFAULTS.windowSec,
    stepSec: parseOptionalNumber(req.body.stepSec) ?? TRAIN_CONFIG_DEFAULTS.stepSec,
    k: optionalNumber(req.body.k, 1, true) ?? TRAIN_CONFIG_DEFAULTS.k,
    maxNoneToSongRatio: optionalNumber(req.body.maxNoneToSongRatio, 0)
      ?? TRAIN_CONFIG_DEFAULTS.maxNoneToSongRatio,
    prototypeBudget: optionalNumber(req.body.prototypeBudget, 1, true),
    maxNonePrototypes: optionalNumber(req.body.maxNonePrototypes, 1, true),
    featureScaling: parseOptionalScaling(req.body.featureScaling),
    registerDivide: optionalNumber(req.body.registerDivide, 1, true),
    handMaskAugmentFraction: optionalClamped(req.body.handMaskAugmentFraction, 0, 1),
    scoreMode: parseOptionalScoreMode(req.body.scoreMode),
    scoreNeighbors: optionalNumber(req.body.scoreNeighbors, 1, true),
    decoder: parseOptionalDecoder(req.body.decoder),
    anchorMargin: optionalNumber(req.body.anchorMargin, 0),
    minAnchorRun: optionalNumber(req.body.minAnchorRun, 1, true),
    fillMinMargin: optionalNumber(req.body.fillMinMargin, 0),
    fillTopK: parseOptionalNumber(req.body.fillTopK),
    linkConfidence: optionalClamped(req.body.linkConfidence, 0, 1),
    linkMaxSilenceRatio: optionalClamped(req.body.linkMaxSilenceRatio, 0, 1),
    linkPolicy: parseOptionalLinkPolicy(req.body.linkPolicy),
    linkTailSec: optionalNumber(req.body.linkTailSec, 0),
    linkRescueRank: optionalNumber(req.body.linkRescueRank, -1),
    noneFromCompleteFilesOnly: parseOptionalBoolean(req.body.noneFromCompleteFilesOnly)
  };
  const includeEvaluation = parseOptionalBoolean(req.body.includeEvaluation) ?? false;
  const reRunUnsure = parseOptionalBoolean(req.body.reRunUnsure) ?? false;

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

  const reRunResults: Array<{
    fileId: number;
    filename: string;
    clearedCount: number;
    insertedCount: number;
    segmentCount: number;
  }> = [];
  const reRunErrors: Array<{ fileId: number; error: string }> = [];
  let reRunFileCount = 0;
  if (reRunUnsure) {
    const eligibleFileIds = PredictionReviewModel.findFileIdsWithOnlyUnsureUnpromoted();
    reRunFileCount = eligibleFileIds.length;
    for (const fileId of eligibleFileIds) {
      try {
        const result = runPredictionImport({
          fileId,
          modelPath,
          config: { ...DEFAULT_PREDICT_CONFIG },
          clearUnpromoted: true,
          rootDir
        });
        reRunResults.push({
          fileId: result.fileId,
          filename: result.filename,
          clearedCount: result.clearedCount,
          insertedCount: result.insertedCount,
          segmentCount: result.segments.length
        });
      } catch (error) {
        reRunErrors.push({
          fileId,
          error: errorMessage(error)
        });
      }
    }
  }

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
    evaluation,
    reRunUnsure,
    reRunFileCount,
    reRunResults,
    reRunErrors
  });
}));

router.get('/rebuild-status', route('get rebuild status', async (_req: Request, res: Response) => {
  const modelPath = path.resolve(process.cwd(), 'data/ml/model.json');
  res.json(getRebuildStatus(modelPath));
}));

router.get('/:id', route('get prediction review', async (req: Request, res: Response) => {
  const id = parseOptionalInt(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'Invalid review id' });
  }

  const review = PredictionReviewModel.findById(id);
  if (!review) {
    return res.status(404).json({ error: 'Prediction review not found' });
  }
  res.json(review);
}));

router.put('/:id', route('update prediction review', async (req: Request, res: Response) => {
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
}));

router.post('/:id/promote', async (req: Request, res: Response) => {
  try {
    const id = parseOptionalInt(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid review id' });
    }

    const result = PredictionReviewModel.promoteToAnnotation(id);
    res.json(result);
  } catch (error) {
    const message = errorMessage(error, 'Failed to promote prediction review');
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
