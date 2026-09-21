import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

/**
 * Nothing in `server/`, `ml/` or `scripts/` loads `.env` itself: each tsx entry
 * point gets it from Node's `--env-file-if-exists` flag, which applies before
 * any module reads `process.env` at import time. A script without the flag
 * silently runs on defaults instead of the user's configuration.
 *
 * `setup` is the exception. It reads and writes `.env` directly.
 */
const ENV_FILE_FLAG = '--env-file-if-exists=.env';
const MANAGES_ENV_FILE_ITSELF = new Set(['setup']);

const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
};

test('every tsx script except setup loads .env', () => {
  const tsxScripts = Object.entries(scripts).filter(([, command]) => /^tsx\b/.test(command));
  assert.ok(tsxScripts.length > 0, 'expected tsx scripts in package.json');

  const missing = tsxScripts
    .filter(([name, command]) => !MANAGES_ENV_FILE_ITSELF.has(name) && !command.includes(ENV_FILE_FLAG))
    .map(([name]) => name);
  assert.deepEqual(missing, []);
});
