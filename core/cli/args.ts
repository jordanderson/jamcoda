/**
 * Argument parsing and small file helpers shared by every CLI entrypoint.
 *
 * `readArg`, `hasFlag`, `parseNum`, `clamp` and `ensureDirForFile` were
 * duplicated across the four `ml/` entrypoints and `server/scripts/migrate.ts`.
 * `ensureDirForFile` was also fixed in only one copy.
 *
 * Node-only: this module reads `process.argv` and touches the filesystem, so
 * it is excluded from the browser program in tsconfig.json.
 */

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// Re-exported so CLI entrypoints can pull everything from one module.
export { clamp, roundTo } from '../math';

/** Value following `flag` on the command line, or undefined if absent. */
export function readArg(flag: string, argv: string[] = process.argv): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

/** Whether a bare `flag` is present on the command line. */
export function hasFlag(flag: string, argv: string[] = process.argv): boolean {
  return argv.includes(flag);
}

/** Parse a numeric option, falling back when absent or not finite. */
export function parseNum(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

/** Parse an integer option, flooring and clamping to a minimum. */
export function parseInt_(value: string | undefined, fallback: number, min = 1): number {
  return Math.max(min, Math.floor(parseNum(value, fallback)));
}

/** Parse a `true|false|1|0|yes|no` option. */
export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return fallback;
}

/** Format a 0..1 ratio as a percentage string. */
export function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Create the parent directory of `filePath` if it does not already exist. */
export function ensureDirForFile(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the SQLite path the CLIs operate on, honouring `--db` then
 * `JAMCODA_DB_PATH` then the repo default.
 */
export function resolveDbPath(argv: string[] = process.argv): string {
  return path.resolve(
    readArg('--db', argv) || process.env.JAMCODA_DB_PATH || 'data/jamcoda.db'
  );
}

/** Run a CLI `main`, reporting failures consistently and setting the exit code. */
export function runMain(label: string, main: () => Promise<void>): void {
  main().catch((error) => {
    console.error(`${label}:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
