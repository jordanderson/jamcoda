import express from 'express';
import * as syncService from '@server/services/sync.service';
import * as FileModel from '@models/File';
import { route } from '@utils/route';
import type { SyncProgressResponse } from '@core/types';

const router = express.Router();

router.post('/start', route('start sync', async (req, res) => {
  const full = req.query.full === '1' || req.body?.full === true;
  const syncId = await syncService.startSync(full);
  res.json({ syncId, status: 'in_progress' });
}));

router.get('/progress/:syncId', (req, res) => {
  const progress = syncService.getSyncProgress(req.params.syncId);
  if (!progress) {
    return res.status(404).json({ error: 'Sync not found' });
  }
  // Elapsed time is measured here, on the server's clock, so the client's
  // ETA never depends on the two clocks agreeing.
  const downloadElapsedMs = progress.downloadStartedAt === null ? null : Date.now() - progress.downloadStartedAt;
  const body: SyncProgressResponse = { ...progress, downloadElapsedMs };
  res.json(body);
});

router.post('/cancel/:syncId', (req, res) => {
  if (!syncService.cancelSync(req.params.syncId)) {
    return res.status(409).json({ error: 'No running sync with that id' });
  }
  res.json({ cancelRequested: true });
});

router.get('/status', (_req, res) => {
  try {
    const metadata = FileModel.getSyncMetadata();
    res.json({
      lastSyncAt: metadata.last_sync_at,
      lastSyncFileCount: metadata.last_sync_file_count,
      hasNeverSynced: !metadata.last_sync_at
    });
  } catch (error) {
    console.error('Error getting sync status:', error);
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

export default router;
