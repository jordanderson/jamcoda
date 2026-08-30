import type Database from 'better-sqlite3';

export interface Migration {
  id: string;
  description: string;
  up: (db: Database.Database) => void;
}

export interface MigrationResult {
  appliedIds: string[];
  totalMigrations: number;
}