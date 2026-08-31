import type { Migration } from './types';

export const skipsMigration: Migration = {
  id: '005-file-skips',
  description: 'Store Jamcorder silence-compression gaps (jmxSkip) parsed from the JMX trailer',
  up: (db) => {
    db.exec(`
      ALTER TABLE files ADD COLUMN skips_json TEXT;
    `);
  }
};