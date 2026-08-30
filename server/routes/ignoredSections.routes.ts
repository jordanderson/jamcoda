import express from 'express';
import * as FileModel from '@models/File';
import * as IgnoredSectionModel from '@models/IgnoredSection';
import * as PredictionReviewModel from '@models/PredictionReview';
import type { IgnoredSection } from '@server/types';

const router = express.Router();

function parseId(raw: unknown): number | null {
  const num = Number(raw);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function parseNumber(raw: unknown): number | null {
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function parseReason(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toApiSection(section: IgnoredSection) {
  return {
    ...section,
    reason: section.reason ?? undefined
  };
}

router.get('/', async (req, res) => {
  try {
    const fileId = parseId(req.query.fileId);
    if (!fileId) {
      return res.status(400).json({ error: 'fileId query param is required' });
    }

    const file = FileModel.findById(fileId);
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    const sections = IgnoredSectionModel.findByFileId(fileId).map(toApiSection);
    res.json({ sections });
  } catch (error) {
    console.error('Error listing ignored sections:', error);
    res.status(500).json({ error: 'Failed to list ignored sections' });
  }
});

router.post('/', async (req, res) => {
  try {
    const fileId = parseId(req.body.fileId);
    const startTime = parseNumber(req.body.startTime);
    const endTime = parseNumber(req.body.endTime);
    const reason = parseReason(req.body.reason);

    if (!fileId || startTime === null || endTime === null) {
      return res.status(400).json({ error: 'fileId, startTime, and endTime are required' });
    }

    if (!(startTime < endTime)) {
      return res.status(400).json({ error: 'startTime must be less than endTime' });
    }
    if (startTime < 0) {
      return res.status(400).json({ error: 'startTime cannot be negative' });
    }

    const file = FileModel.findById(fileId);
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    const id = IgnoredSectionModel.create({
      fileId,
      startTime,
      endTime,
      reason
    });
    const section = IgnoredSectionModel.findById(id);
    if (!section) {
      return res.status(500).json({ error: 'Ignored section was created but could not be loaded' });
    }

    const clearedPredictionCount = PredictionReviewModel.deleteUnpromotedOverlappingRange(
      fileId,
      startTime,
      endTime
    );

    res.status(201).json({
      section: toApiSection(section),
      clearedPredictionCount
    });
  } catch (error) {
    console.error('Error creating ignored section:', error);
    res.status(500).json({ error: 'Failed to create ignored section' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid ignored section id' });
    }

    const success = IgnoredSectionModel.remove(id);
    if (!success) {
      return res.status(404).json({ error: 'Ignored section not found' });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting ignored section:', error);
    res.status(500).json({ error: 'Failed to delete ignored section' });
  }
});

export default router;
