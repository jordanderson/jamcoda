import type { Migration } from './types';

export const syncAssetMetadataMigration: Migration = {
  id: '002-sync-asset-metadata',
  description: 'Track JMX asset identity and trailer offset for reliable incremental sync',
  up: (db) => {
    db.exec(`
      ALTER TABLE files ADD COLUMN asset_uuid TEXT;
      ALTER TABLE files ADD COLUMN jmx_eof_offset INTEGER;
    `);
  }
};