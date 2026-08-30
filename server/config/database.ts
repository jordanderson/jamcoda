import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { runMigrations } from './migrations.js';

const APP_DB_PATH = './data/jamcoda.db';
let db: Database.Database | undefined;
let activeDbPath: string | undefined;

export interface InitializeDatabaseResult {
  dbPath: string;
  appliedMigrations: string[];
  totalMigrations: number;
}

function resolveDbPath(): string {
  return process.env.JAMCODA_DB_PATH || APP_DB_PATH;
}

export function initializeDatabase(): InitializeDatabaseResult {
  const dbPath = resolveDbPath();
  const isTestRun = process.env.NODE_ENV === 'test' || process.argv.includes('--test');
  if (isTestRun) {
    if (!process.env.JAMCODA_DB_PATH) {
      throw new Error('Refusing to run tests against app DB. Set JAMCODA_DB_PATH to a dedicated test database path.');
    }

    const resolvedDbPath = resolve(dbPath);
    const resolvedAppDbPath = resolve(APP_DB_PATH);
    if (resolvedDbPath === resolvedAppDbPath) {
      throw new Error('Refusing to run tests against app DB path.');
    }
  }

  if (db && activeDbPath === dbPath) {
    return {
      dbPath,
      appliedMigrations: [],
      totalMigrations: 0
    };
  }

  if (db && activeDbPath !== dbPath) {
    db.close();
    db = undefined;
    activeDbPath = undefined;
  }

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  activeDbPath = dbPath;

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  const migrationResult = runMigrations(db);
  if (migrationResult.appliedIds.length > 0) {
    console.log(`Database initialized successfully (${migrationResult.appliedIds.length} migration(s) applied)`);
  } else {
    console.log('Database initialized successfully (no pending migrations)');
  }

  return {
    dbPath,
    appliedMigrations: migrationResult.appliedIds,
    totalMigrations: migrationResult.totalMigrations
  };
}

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

export function closeDatabase() {
  if (db) {
    db.close();
    db = undefined;
    activeDbPath = undefined;
  }
}
