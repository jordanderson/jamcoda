import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { datasetIdentity, EvalScoreCache, scoringConfig, scoringSourceFiles } from './evalCache';
import type { AnnotatedMidiFile, TrainConfig } from './songSegmentation';

describe('evaluation score cache', () => {
  it('round-trips nonfinite absent-label scores and isolates folds and identities', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'jamcoda-eval-cache-'));
    try {
      const cache = new EvalScoreCache(directory, { dataset: 'a', mode: 'loo' });
      const value = { labels: ['__none__', 'A'], scores: [[-Infinity, -0], [-5, -1.2]] };
      assert.equal(cache.read(1, 2), undefined);
      cache.write(1, value);
      assert.deepEqual(cache.read(1, 2), value);
      assert.equal(cache.read(2, 2), undefined);
      assert.equal(cache.read(1, 3), undefined);
      assert.equal(new EvalScoreCache(directory, { dataset: 'b', mode: 'loo' }).read(1, 2), undefined);
      cache.write(2, { labels: ['A'], scores: [[NaN]] });
      assert.equal(cache.read(2, 1), undefined);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('invalidates on annotations, completion, MIDI content, membership and training settings', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'jamcoda-eval-dataset-'));
    try {
      const midiPath = path.join(directory, 'test.mid');
      writeFileSync(midiPath, 'midi-one');
      const file: AnnotatedMidiFile = { fileId: 1, filename: 'test.mid', midiPath, isComplete: true,
        annotations: [{ songName: 'A', startTime: 1, endTime: 10 }] };
      const original = datasetIdentity([file]).sha256;
      assert.equal(datasetIdentity([{ ...file }]).sha256, original);
      assert.notEqual(datasetIdentity([{ ...file, isComplete: false }]).sha256, original);
      assert.notEqual(datasetIdentity([{ ...file, annotations: [{ songName: 'A', startTime: 2, endTime: 10 }] }]).sha256, original);
      assert.notEqual(datasetIdentity([file, { ...file, fileId: 2 }]).sha256, original);
      writeFileSync(midiPath, 'midi-two');
      assert.notEqual(datasetIdentity([file]).sha256, original);
      const config: TrainConfig = { windowSec: 6, stepSec: 1, k: 7, maxNoneToSongRatio: 1.5 };
      assert.deepEqual(scoringConfig(config), scoringConfig({ ...config, anchorMargin: 0.2, anchorGapPolicy: 'evidence' }));
      for (const change of [{ windowSec: 8 }, { registerDivide: 72 }, { prototypeBudget: 12000 },
        { noneFromCompleteFilesOnly: true }, { scoreNeighbors: 3 }]) {
        assert.notDeepEqual(scoringConfig(config), scoringConfig({ ...config, ...change }));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('invalidates when any segmentation source file changes', () => {
    // Features, fitting and scoring live in ml/segmentation/. A file missing
    // from the identity would let an edit to it reuse the old code's scores.
    const segmentation = readdirSync(path.join(import.meta.dirname, 'segmentation'))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    assert.ok(segmentation.length > 0);
    const hashed = scoringSourceFiles();
    for (const name of segmentation) assert.ok(hashed.includes(`./segmentation/${name}`), name);
    assert.ok(hashed.includes('./songSegmentation.ts'));
  });
});
