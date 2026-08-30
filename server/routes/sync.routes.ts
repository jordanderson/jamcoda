import express from 'express';
import * as syncService from '@server/services/sync.service';
import * as FileModel from '@models/File';

const router = express.Router();

router.post('/start', async (req, res) => {
  try {
    const full = req.query.full === '1' || req.body?.full === true;
    const syncId = await syncService.startSync(full);
    res.json({ syncId, status: 'in_progress' });
  } catch (error) {
    console.error('Error starting sync:', error);
    res.status(500).json({ error: 'Failed to start sync' });
  }
});

router.get('/progress/:syncId', (req, res) => {
  const progress = syncService.getSyncProgress(req.params.syncId);
  if (!progress) {
    return res.status(404).json({ error: 'Sync not found' });
  }
  res.json(progress);
});

router.get('/status', (req, res) => {
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
