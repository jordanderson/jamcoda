import express from 'express';
import * as AnnotationModel from '@models/Annotation';
import * as PredictionReviewModel from '@models/PredictionReview';
import type { RenameSongNameResult } from '@server/types';

const router = express.Router();

function parseSongName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

router.get('/song-names/unique', async (req, res) => {
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

router.get('/songs', async (req, res) => {
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
