import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as AnnotationModel from '@models/Annotation';
import * as PredictionReviewModel from '@models/PredictionReview';
import * as FileModel from '@models/File';
import { libraryModelPath, resolveStoredMidiPath } from '@config/library';
import { loadModel, suggestSongsForRange } from '../../ml/songSegmentation';
import type { Annotation, RenameSongNameResult } from '@server/types';
import { route } from '@utils/route';
import { errorMessage } from '@core/errors';
import { parseOptionalNumber, parseSongName } from '@utils/requestParams';

const router = express.Router();

router.post('/song-suggestions', route('suggest songs', async (req, res) => {
  const fileId = parseOptionalNumber(req.body.fileId);
  const startTime = parseOptionalNumber(req.body.startTime);
  const endTime = parseOptionalNumber(req.body.endTime);

  if (!fileId || startTime === undefined || endTime === undefined || startTime >= endTime) {
    return res.status(400).json({ error: 'fileId, startTime and endTime (start < end) are required' });
  }

  const file = FileModel.findById(fileId);
  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }

  const modelPath = (typeof req.body.modelPath === 'string' && req.body.modelPath.trim())
    ? path.resolve(req.body.modelPath.trim())
    : libraryModelPath();
  if (!existsSync(modelPath)) {
    return res.json({ suggestions: [] });
  }

  const midiPath = resolveStoredMidiPath(file.local_path);
  if (!existsSync(midiPath)) {
    return res.json({ suggestions: [] });
  }

  const model = loadModel(modelPath);
  const suggestions = suggestSongsForRange(model, midiPath, startTime, endTime, {
    minConfidence: parseOptionalNumber(req.body.minConfidence) ?? 0.3,
    topK: 4
  });

  res.json({ suggestions });
}));

router.get('/song-names/unique', route('get song names', async (_req, res) => {
  const songNames = AnnotationModel.getUniqueSongNames();
  res.json(songNames);
}));

router.post('/song-names/rename', route('rename song name', async (req, res) => {
  const oldSongName = parseSongName(req.body.oldSongName);
  const newSongName = parseSongName(req.body.newSongName);

  if (!oldSongName || !newSongName) {
    return res.status(400).json({ error: 'oldSongName and newSongName are required' });
  }

  if (oldSongName === newSongName) {
    return res.status(400).json({ error: 'oldSongName and newSongName must be different' });
  }

  const annotationsUpdated = AnnotationModel.renameSongName(oldSongName, newSongName);
  const predictionUpdates = PredictionReviewModel.renameSongNameReferences(oldSongName, newSongName);

  const result: RenameSongNameResult = {
    oldSongName,
    newSongName,
    annotationsUpdated,
    predictionReviewsPredictedUpdated: predictionUpdates.predictedUpdated,
    predictionReviewsReviewedUpdated: predictionUpdates.reviewedUpdated
  };

  res.json(result);
}));

router.get('/songs', route('get song play history', async (_req, res) => {
  const history = AnnotationModel.getSongPlayHistory();
  res.json({ songs: history });
}));

router.get('/:fileId', route('get labels', async (req, res) => {
  const fileId = parseInt(req.params.fileId);
  const annotations = AnnotationModel.findByFileId(fileId);
  res.json(annotations);
}));

router.post('/', route('create label', async (req, res) => {
  const { fileId, songName, startTime, endTime, notes } = req.body;

  if (!fileId || !songName || startTime === undefined || endTime === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (startTime >= endTime) {
    return res.status(400).json({ error: 'startTime must be less than endTime' });
  }

  const id = AnnotationModel.create({
    fileId,
    songName,
    startTime,
    endTime,
    notes
  });

  const annotation = AnnotationModel.findById(id);
  res.status(201).json(annotation);
}));

router.put('/:id', route('update label', async (req, res) => {
  const id = parseInt(req.params.id);
  const { songName, startTime, endTime, notes } = req.body;

  if (startTime !== undefined && endTime !== undefined && startTime >= endTime) {
    return res.status(400).json({ error: 'startTime must be less than endTime' });
  }

  const success = AnnotationModel.update(id, {
    songName,
    startTime,
    endTime,
    notes
  });

  if (!success) {
    return res.status(404).json({ error: 'Label not found' });
  }

  const shouldMergeSameSongOverlaps = (
    songName !== undefined
    || startTime !== undefined
    || endTime !== undefined
  );

  let annotation: Annotation | undefined;
  let absorbedIds: number[] = [];
  if (shouldMergeSameSongOverlaps) {
    const merged = AnnotationModel.mergeOverlappingSameSong(id);
    annotation = merged?.annotation;
    absorbedIds = merged?.absorbedIds ?? [];
  } else {
    annotation = AnnotationModel.findById(id);
  }

  if (!annotation) {
    return res.status(404).json({ error: 'Label not found' });
  }

  // `absorbedIds` rides along on the annotation so a client can tell an
  // ordinary edit (nothing else moved -- patch the one row) from a merge
  // (other rows are gone -- refetch). An empty array is the common case.
  //
  // `notes` is normalized the way `GET /api/files/:id` does it, so the same
  // annotation serializes identically on both routes. A client patching its
  // cache from this response has to end up deep-equal to what the file
  // refetch returns, or it pays for a redundant re-render of the roll.
  res.json({ ...annotation, notes: annotation.notes ?? undefined, absorbedIds });
}));

router.post('/:id/split', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const holeStartTime = parseOptionalNumber(req.body.holeStartTime ?? req.body.startTime);
    const holeEndTime = parseOptionalNumber(req.body.holeEndTime ?? req.body.endTime);

    if (holeStartTime === undefined || holeEndTime === undefined) {
      return res.status(400).json({ error: 'holeStartTime and holeEndTime are required' });
    }

    if (holeStartTime >= holeEndTime) {
      return res.status(400).json({ error: 'holeStartTime must be less than holeEndTime' });
    }

    const existing = AnnotationModel.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Label not found' });
    }

    if (holeStartTime <= existing.start_time || holeEndTime >= existing.end_time) {
      return res.status(400).json({
        error: `Split hole [${holeStartTime}, ${holeEndTime}] must be strictly within label bounds [${existing.start_time}, ${existing.end_time}]`
      });
    }

    const result = AnnotationModel.split(id, holeStartTime, holeEndTime);
    res.json(result);
  } catch (error) {
    console.error('Error splitting annotation:', error);
    res.status(500).json({ error: errorMessage(error, 'Failed to split label') });
  }
});

router.delete('/:id', route('delete label', async (req, res) => {
  const id = parseInt(req.params.id);
  const success = AnnotationModel.remove(id);

  if (!success) {
    return res.status(404).json({ error: 'Label not found' });
  }

  res.status(204).send();
}));

export default router;
