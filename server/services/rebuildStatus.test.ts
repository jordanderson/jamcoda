import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempDir = mkdtempSync(join(tmpdir(), 'jamcoda-rebuild-status-'));
process.env.JAMCODA_DB_PATH = join(tempDir, 'jamcoda.db');

import { findMissingLabels, getRebuildStatus } from './rebuildStatus';

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.JAMCODA_DB_PATH;
});

test('findMissingLabels returns only labels the model has never seen', () => {
  const modelLabels = ['Song A', 'Song B', '__none__'];
  assert.deepEqual(
    findMissingLabels(['Song A', 'Song C', 'Song B', 'Song D'], modelLabels),
    ['Song C', 'Song D']
  );
  assert.deepEqual(findMissingLabels(['Song A'], modelLabels), []);
  assert.deepEqual(findMissingLabels([], modelLabels), []);
});

test('getRebuildStatus reports no model when the file is absent or unreadable', () => {
  const status = getRebuildStatus(join(tempDir, 'does-not-exist.json'));
  assert.equal(status.modelExists, false);
  assert.equal(status.hasPendingChanges, false);
  assert.equal(status.pendingAnnotationCount, 0);
  assert.deepEqual(status.missingLabels, []);
});