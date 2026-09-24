import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  id: string;
  description: string;
  /** `dbPath` is the absolute path of the database being migrated. */
  up: (db: DatabaseSync, dbPath: string) => void;
}

export interface MigrationResult {
  appliedIds: string[];
  totalMigrations: number;
}