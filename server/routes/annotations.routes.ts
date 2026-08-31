import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as AnnotationModel from '@models/Annotation';
import * as PredictionReviewModel from '@models/PredictionReview';
import * as FileModel from '@models/File';
import { loadModel, suggestSongsForRange } from '../../ml/songSegmentation';
import type { RenameSongNameResult } from '@server/types';

const router = express.Router();

function parseSongName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

router.post('/song-suggestions', async (req, res) => {
  try {
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

    const modelPath = path.resolve(
      (typeof req.body.modelPath === 'string' && req.body.modelPath.trim())
        ? req.body.modelPath.trim()
        : 'data/ml/model.json'
    );
    if (!existsSync(modelPath)) {
      return res.json({ suggestions: [] });
    }

    const midiPath = path.isAbsolute(file.local_path)
      ? file.local_path
      : path.resolve(process.cwd(), file.local_path);
    if (!existsSync(midiPath)) {
      return res.json({ suggestions: [] });
    }

    const model = loadModel(modelPath);
    const suggestions = suggestSongsForRange(model, midiPath, startTime, endTime, {
      minConfidence: parseOptionalNumber(req.body.minConfidence) ?? 0.3,
      topK: 4
    });

    res.json({ suggestions });
  } catch (error) {
    console.error('Error suggesting songs for range:', error);
    res.status(500).json({ error: 'Failed to suggest songs' });
  }
});

router.get('/song-names/unique', async (_req, res) => {
  try {
    const songNames = AnnotationModel.getUniqueSongNames();
    res.json(songNames);
  } catch (error) {
    console.error('Error getting unique song names:', error);
    res.status(500).json({ error: 'Failed to get song names' });
  }
});

router.post('/song-names/rename', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Error renaming song name:', error);
    res.status(500).json({ error: 'Failed to rename song name' });
  }
});

router.get('/songs', async (_req, res) => {
  try {
    const history = AnnotationModel.getSongPlayHistory();
    res.json({ songs: history });
  } catch (error) {
    console.error('Error getting song play history:', error);
    res.status(500).json({ error: 'Failed to get song play history' });
  }
});

router.get('/:fileId', async (req, res) => {
  try {
    const fileId = parseInt(req.params.fileId);
    const annotations = AnnotationModel.findByFileId(fileId);
    res.json(annotations);
  } catch (error) {
    console.error('Error getting annotations:', error);
    res.status(500).json({ error: 'Failed to get annotations' });
  }
});

router.post('/', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Error creating annotation:', error);
    res.status(500).json({ error: 'Failed to create annotation' });
  }
});

router.put('/:id', async (req, res) => {
  try {
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
      return res.status(404).json({ error: 'Annotation not found' });
    }

    const shouldMergeSameSongOverlaps = (
      songName !== undefined
      || startTime !== undefined
      || endTime !== undefined
    );
    const annotation = shouldMergeSameSongOverlaps
      ? AnnotationModel.mergeOverlappingSameSong(id)
      : AnnotationModel.findById(id);

    if (!annotation) {
      return res.status(404).json({ error: 'Annotation not found' });
    }

    res.json(annotation);
  } catch (error) {
    console.error('Error updating annotation:', error);
    res.status(500).json({ error: 'Failed to update annotation' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const success = AnnotationModel.remove(id);

    if (!success) {
      return res.status(404).json({ error: 'Annotation not found' });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting annotation:', error);
    res.status(500).json({ error: 'Failed to delete annotation' });
  }
});

export default router;
