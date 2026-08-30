import express from 'express';
import { readFileSync } from 'fs';
import * as FileModel from '@models/File';
import * as AnnotationModel from '@models/Annotation';
import * as IgnoredSectionModel from '@models/IgnoredSection';
import * as PredictionReviewModel from '@models/PredictionReview';
import { getMidiDuration } from '@utils/midiUtils';

const router = express.Router();

function parseId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get('/by-date', async (req, res) => {
  try {
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;

    const files = FileModel.findByDate(startDate, endDate);

    // Group files by date
    const grouped = files.reduce((acc, file) => {
      const date = file.date_recorded;
      if (!acc[date]) {
        acc[date] = [];
      }

      // Add annotation count and percentage
      const annotationCount = AnnotationModel.countByFileId(file.id);
      const annotatedDuration = AnnotationModel.getTotalAnnotatedDuration(file.id);
      const annotations = AnnotationModel.getAnnotationsByFileId(file.id);
      const unreviewedPredictionCount = PredictionReviewModel.count({
        fileId: file.id,
        status: 'unsure',
        includePromoted: false
      });
      const totalDuration = (
        typeof file.midi_duration === 'number'
        && Number.isFinite(file.midi_duration)
        && file.midi_duration >= 0
      )
        ? file.midi_duration
        : (() => {
          const calculatedDuration = getMidiDuration(file.local_path);
          FileModel.setMidiDuration(file.id, calculatedDuration);
          return calculatedDuration;
        })();
      const percentageAnnotated = totalDuration > 0
        ? Math.round((annotatedDuration / totalDuration) * 100)
        : 0;

      acc[date].push({
        id: file.id,
        filename: file.filename,
        fileSize: file.file_size,
        dateRecorded: file.date_recorded,
        isComplete: file.is_complete === 1,
        completedAt: file.completed_at,
        annotationCount,
        percentageAnnotated,
        totalDuration,
        annotatedDuration,
        annotations,
        unreviewedPredictionCount
      });

      return acc;
    }, {} as Record<string, any[]>);

    // Convert to array format
    const dates = Object.keys(grouped).map(date => ({
      date,
      files: grouped[date]
    }));

    res.json({ dates });
  } catch (error) {
    console.error('Error getting files by date:', error);
    res.status(500).json({ error: 'Failed to get files' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid file id' });
    }
    const file = FileModel.findById(id);

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    const annotations = AnnotationModel.findByFileId(id).map((annotation) => ({
      ...annotation,
      notes: annotation.notes ?? undefined
    }));
    const ignoredSections = IgnoredSectionModel.findByFileId(id).map((section) => ({
      ...section,
      reason: section.reason ?? undefined
    }));

    res.json({
      id: file.id,
      filename: file.filename,
      dateRecorded: file.date_recorded,
      fileSize: file.file_size,
      localPath: file.local_path,
      jamcorderPath: file.jamcorder_path,
      syncedAt: file.synced_at,
      isComplete: file.is_complete === 1,
      completedAt: file.completed_at,
      annotations,
      ignoredSections
    });
  } catch (error) {
    console.error('Error getting file detail:', error);
    res.status(500).json({ error: 'Failed to get file detail' });
  }
});

router.put('/:id/completion', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid file id' });
    }

    if (typeof req.body.isComplete !== 'boolean') {
      return res.status(400).json({ error: 'isComplete must be a boolean' });
    }

    const existing = FileModel.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'File not found' });
    }

    const success = FileModel.setCompletion(id, req.body.isComplete);
    if (!success) {
      return res.status(404).json({ error: 'File not found' });
    }

    const clearedPredictionCount = req.body.isComplete
      ? PredictionReviewModel.deleteByFileId(id)
      : 0;
    const updated = FileModel.findById(id);
    if (!updated) {
      return res.status(500).json({ error: 'File disappeared after completion update' });
    }

    res.json({
      id: updated.id,
      isComplete: updated.is_complete === 1,
      completedAt: updated.completed_at,
      clearedPredictionCount
    });
  } catch (error) {
    console.error('Error updating file completion:', error);
    res.status(500).json({ error: 'Failed to update file completion' });
  }
});

router.get('/:id/download', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid file id' });
    }
    const file = FileModel.findById(id);

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    const data = readFileSync(file.local_path);
    res.setHeader('Content-Type', 'audio/midi');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(data);
  } catch (error) {
    console.error('Error downloading file:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

export default router;
