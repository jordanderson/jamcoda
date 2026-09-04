import type { Migration } from './types';

export const dropIgnoredSectionsMigration: Migration = {
  id: '006-drop-ignored-sections',
  description: 'Drop ignored_sections table',
  up: (db) => {
    db.exec(`
      DROP TABLE IF EXISTS ignored_sections;
    `);
  }
};
