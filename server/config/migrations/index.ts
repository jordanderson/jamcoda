import type Database from 'better-sqlite3';
import type { Migration, MigrationResult } from './types';
import { initialSchemaMigration } from './001-initial-schema';
import { syncAssetMetadataMigration } from './002-sync-asset-metadata';
import { syncHighWaterMarkMigration } from './003-sync-high-water-mark';
import { bookmarksMigration } from './004-file-bookmarks';
import { skipsMigration } from './005-file-skips';

/**
 * All migrations, in application order. New migrations should be added as
 * their own file in this directory and appended here.
 */
const migrations: Migration[] = [
  initialSchemaMigration,
  syncAssetMetadataMigration,
  syncHighWaterMarkMigration,
  bookmarksMigration,
  skipsMigration
];

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

export function runMigrations(db: Database.Database): MigrationResult {
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

  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue;
    }

    const tx = db.transaction(() => {
      migration.up(db);
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