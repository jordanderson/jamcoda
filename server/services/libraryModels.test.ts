import assert from 'node:assert/strict';
import { afterAll as after, beforeAll as before, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempDir = mkdtempSync(join(tmpdir(), 'jamcoda-library-models-'));
process.env.JAMCODA_DB_PATH = join(tempDir, 'jamcoda.db');

import { listLibraryModels, resolveLibraryModel } from './libraryModels';
import { NO_SONG_LABEL, saveModel, trainModelFromSamples, type WindowSample } from '../../ml/songSegmentation';

function fitModel(featureCount: number, chordIoiFeatures: boolean) {
  const samples: WindowSample[] = Array.from({ length: 40 }, (_, i) => ({
    fileId: 1, fileName: '', fileIsComplete: true, startTime: i, endTime: i + 4,
    label: i < 20 ? 'Song A' : NO_SONG_LABEL,
    features: i < 20 ? [0.8, 0.2, ...new Array(featureCount - 2).fill(0.1)] : new Array(featureCount).fill(0)
  }));
  return trainModelFromSamples(samples, {
    windowSec: 4, stepSec: 1, k: 3, maxNoneToSongRatio: 1.5, chordIoiFeatures
  });
}

const mlDir = join(tempDir, 'ml');

before(() => {
  mkdirSync(mlDir);
  saveModel(fitModel(37, false), join(mlDir, 'model.json'));
  saveModel(fitModel(53, true), join(mlDir, 'model-chord-ioi.json'));
  // A model from before its feature setting was recorded: 53 features, no flag.
  const unmarked = fitModel(53, true);
  delete unmarked.config.chordIoiFeatures;
  writeFileSync(join(mlDir, 'unmarked.json'), JSON.stringify(unmarked));
  // Eval reports share the folder and are not models.
  writeFileSync(join(mlDir, 'eval-loo-v2.13.json'), JSON.stringify({ dataset: {}, segment: {} }));
  mkdirSync(join(mlDir, 'eval-cache'));
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.JAMCODA_DB_PATH;
});

test('lists the models in the library ml folder, the library model first', () => {
  const models = listLibraryModels();
  assert.deepEqual(models.map((model) => model.name).sort(), ['model-chord-ioi.json', 'model.json', 'unmarked.json']);
  assert.equal(models[0].name, 'model.json');
  assert.equal(models[0].isLibraryModel, true);
  assert.equal(models[0].featureCount, 37);

  const chordIoi = models.find((model) => model.name === 'model-chord-ioi.json')!;
  assert.equal(chordIoi.isLibraryModel, false);
  assert.equal(chordIoi.chordIoiFeatures, true);
  assert.equal(chordIoi.featureCount, 53);
  assert.equal(chordIoi.error, null);
});

test('reports a model this build cannot load instead of hiding it', () => {
  const unmarked = listLibraryModels().find((model) => model.name === 'unmarked.json')!;
  assert.match(unmarked.error ?? '', /different feature set/);
  assert.equal(unmarked.featureCount, null);
});

test('resolves a model by file name only, never by path', () => {
  assert.equal(resolveLibraryModel('model-chord-ioi.json'), join(mlDir, 'model-chord-ioi.json'));
  for (const name of ['../jamcoda.db', 'eval-cache/x.json', '/etc/passwd', '.hidden.json', 'model']) {
    assert.throws(() => resolveLibraryModel(name), /Not a model file name/, name);
  }
  assert.throws(() => resolveLibraryModel('missing.json'), /No model named missing.json/);
});
