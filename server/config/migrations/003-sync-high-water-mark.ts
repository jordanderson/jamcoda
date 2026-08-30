import type { Migration } from './types';

export const syncHighWaterMarkMigration: Migration = {
  id: '003-sync-high-water-mark',
  description: 'Record a high-water mark so steady-state syncs skip already-synced assets',
  up: (db) => {
    db.exec(`
      ALTER TABLE sync_metadata ADD COLUMN high_water_asset_idx INTEGER;
      ALTER TABLE sync_metadata ADD COLUMN high_water_jamcorder_uuid TEXT;
    `);
  }
};