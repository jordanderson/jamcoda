import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempDir = mkdtempSync(join(tmpdir(), 'jamcoda-rebuild-status-'));
process.env.JAMCODA_DB_PATH = join(tempDir, 'jamcoda.db');

import { findMissingLabels, getRebuildStatus } from './rebuildStatus';
import { FEATURE_NAMES } from '../../ml/songSegmentation';

let closeDatabase: () => void;

// The status counts annotations changed since the model was built, so the
// cases with a model file on disk need a database to count against.
before(async () => {
  const databaseModule = await import('../config/database');
  closeDatabase = databaseModule.closeDatabase;
  databaseModule.initializeDatabase();
});

after(() => {
  closeDatabase();
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

function writeModel(path: string, createdAt: string, labels: string[]): void {
  const features = FEATURE_NAMES.map(() => 0);
  const model = {
    modelType: 'knn-song-segmenter',
    version: 2,
    createdAt,
    config: {},
    featureNames: [...FEATURE_NAMES],
    labels,
    featureMeans: features,
    featureStds: features.map(() => 1),
    prototypes: [{ features, labelIndex: 0 }],
    prototypeCounts: [1],
    trainingSummary: { filesUsed: 1, annotationsUsed: 7, totalSamples: 1 }
  };
  writeFileSync(path, JSON.stringify(model));
}

test('a rebuilt model file is re-read rather than served from the cache', () => {
  const modelPath = join(tempDir, 'model.json');
  writeModel(modelPath, '2026-01-01T00:00:00.000Z', ['Song A', '__none__']);

  const first = getRebuildStatus(modelPath);
  assert.equal(first.modelExists, true);
  assert.equal(first.modelCreatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(first.modelAnnotationsUsed, 7);

  // Repeated reads of an unchanged file are answered from the cache: the
  // status has to be identical, not merely fresh.
  assert.deepEqual(getRebuildStatus(modelPath), first);

  // A rebuild rewrites the file. The badge must follow it -- caching the
  // parsed summary must not outlive the file it came from.
  writeModel(modelPath, '2026-06-01T00:00:00.000Z', ['Song A', 'Song B', '__none__']);
  const second = getRebuildStatus(modelPath);
  assert.equal(second.modelCreatedAt, '2026-06-01T00:00:00.000Z');
  assert.deepEqual(second.missingLabels, []);
});

test('the cached summary is keyed per path, not shared between models', () => {
  const oldPath = join(tempDir, 'old-model.json');
  const newPath = join(tempDir, 'new-model.json');
  writeModel(oldPath, '2025-01-01T00:00:00.000Z', ['Song A']);
  writeModel(newPath, '2026-09-01T00:00:00.000Z', ['Song A']);

  assert.equal(getRebuildStatus(oldPath).modelCreatedAt, '2025-01-01T00:00:00.000Z');
  assert.equal(getRebuildStatus(newPath).modelCreatedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(getRebuildStatus(oldPath).modelCreatedAt, '2025-01-01T00:00:00.000Z');
});
