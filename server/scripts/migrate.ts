import path from 'node:path';
import { closeDatabase, initializeDatabase } from '../config/database.js';

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function usage() {
  console.log(`
Run all pending database migrations.

Usage:
  npm run db:migrate -- [options]

Options:
  --db <path>   SQLite DB path (default: data/jamcoda.db)
  --help        Show this help
`);
}

async function main() {
  if (hasFlag('--help')) {
    usage();
    return;
  }

  const dbPath = path.resolve(readArg('--db') || process.env.JAMCODA_DB_PATH || 'data/jamcoda.db');
  process.env.JAMCODA_DB_PATH = dbPath;

  const result = initializeDatabase();
  closeDatabase();

  if (result.appliedMigrations.length === 0) {
    console.log(`No pending migrations. Database is up to date: ${result.dbPath}`);
    return;
  }

  console.log(`Applied migrations to ${result.dbPath}:`);
  for (const migrationId of result.appliedMigrations) {
    console.log(`- ${migrationId}`);
  }
}

main().catch((error) => {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
