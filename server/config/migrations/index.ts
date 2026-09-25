import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Migration, MigrationResult } from './types';
import { initialSchemaMigration } from './001-initial-schema';
import { syncAssetMetadataMigration } from './002-sync-asset-metadata';
import { syncHighWaterMarkMigration } from './003-sync-high-water-mark';
import { bookmarksMigration } from './004-file-bookmarks';
import { skipsMigration } from './005-file-skips';
import { dropIgnoredSectionsMigration } from './006-drop-ignored-sections';
import { libraryRelativePathsMigration } from './007-library-relative-paths';
import { predictionEvidenceMigration } from './008-prediction-evidence';
import { nowUnix } from '@utils/time';
import { transaction } from '../transaction';

/**
 * All migrations, in application order. New migrations should be added as
 * their own file in this directory and appended here.
 */
const migrations: Migration[] = [
  initialSchemaMigration,
  syncAssetMetadataMigration,
  syncHighWaterMarkMigration,
  bookmarksMigration,
  skipsMigration,
  dropIgnoredSectionsMigration,
  libraryRelativePathsMigration,
  predictionEvidenceMigration
];

export function runMigrations(db: DatabaseSync, dbPath: string): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>;
  const applied = new Set(appliedRows.map((row) => row.id));
  const appliedIds: string[] = [];

  const insertApplied = db.prepare(`
    INSERT INTO schema_migrations (id, description, applied_at)
    VALUES (?, ?, ?)
  `);

  // An existing database is copied before anything is applied to it, so a
  // migration that rewrites data can always be undone by hand. A new one has
  // nothing to lose. The copy is named for the first pending migration and
  // made once: a migration that refuses leaves the database unchanged, so a
  // later attempt has nothing new to back up.
  const pending = migrations.filter((migration) => !applied.has(migration.id));
  if (pending.length > 0 && applied.size > 0) {
    const backupPath = `${dbPath}.pre-${pending[0].id}`;
    if (!existsSync(backupPath)) {
      db.prepare('VACUUM INTO ?').run(backupPath);
      console.log(`Backed up the database to ${backupPath} before migrating`);
    }
  }

  for (const migration of pending) {
    const tx = transaction(db, () => {
      migration.up(db, dbPath);
      insertApplied.run(migration.id, migration.description, nowUnix());
    });
    tx();
    appliedIds.push(migration.id);
  }

  return {
    appliedIds,
    totalMigrations: migrations.length
  };
}