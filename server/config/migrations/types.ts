import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  id: string;
  description: string;
  up: (db: DatabaseSync) => void;
}

export interface MigrationResult {
  appliedIds: string[];
  totalMigrations: number;
}