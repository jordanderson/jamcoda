import type { Migration } from './types';

export const bookmarksMigration: Migration = {
  id: '004-file-bookmarks',
  description: 'Store Jamcorder passage bookmarks parsed from the JMX trailer',
  up: (db) => {
    db.exec(`
      ALTER TABLE files ADD COLUMN bookmarks_json TEXT;
    `);
  }
};