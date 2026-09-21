import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createNearestPrototypeScorer } from './prototypeScorer';
import { decodeWindowScores, predictWindowsFromSamples, scoreWindowsFromSamples, trainModelFromSamples,
  type TrainConfig, type WindowSample } from './songSegmentation';

describe('contiguous nearest-prototype scoring', () => {
  it('exactly matches full-distance reference with interleaved labels, ties and absent labels', () => {
    let seed = 42;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const prototypes = Array.from({ length: 513 }, (_, i) => ({
      features: Array.from({ length: 37 }, () => random() * 10 - 5), labelIndex: i % 7
    }));
    prototypes.push(prototypes[0]);
    const score = createNearestPrototypeScorer(prototypes, 8);
    for (let query = 0; query < 100; query++) {
      const vector = query === 0 ? prototypes[0].features : Array.from({ length: 37 }, () => random());
      const expected = new Array<number>(8).fill(Infinity);
      for (const prototype of prototypes) {
        let distance = 0;
        for (let i = 0; i < vector.length; i++) {
          const diff = vector[i] - prototype.features[i];
          distance += diff * diff;
        }
        expected[prototype.labelIndex] = Math.min(expected[prototype.labelIndex], distance);
      }
      assert.deepEqual(score(vector), expected.map((value) => -Math.sqrt(value)));
    }
  });

  it('separates scoring from all decoders and preserves avg/multiple-neighbor scoring', () => {
    const samples: WindowSample[] = Array.from({ length: 60 }, (_, i) => ({
      features: Array.from({ length: 37 }, (_, j) => (i % 20) + j / 37),
      label: i < 20 ? '__none__' : i < 40 ? 'A' : 'B',
      fileId: i % 2, fileName: '', fileIsComplete: true, startTime: i, endTime: i + 6
    }));
    const config: TrainConfig = { windowSec: 6, stepSec: 1, k: 7, maxNoneToSongRatio: 1.5, prototypeBudget: 40 };
    for (const decoder of ['anchor', 'smooth', 'viterbi'] as const) {
      for (const scoreMode of ['min', 'avg'] as const) {
        for (const scoreNeighbors of [1, 3]) {
          const model = trainModelFromSamples(samples, { ...config, decoder, scoreMode, scoreNeighbors });
          const options = { minWindowConfidence: 0.1, smoothingWindows: 3 };
          const scores = scoreWindowsFromSamples(model, samples);
          const before = structuredClone(scores);
          assert.deepEqual(decodeWindowScores(model, samples, scores, options), predictWindowsFromSamples(model, samples, options));
          assert.deepEqual(scores, before, 'decoding does not alter reusable scores');
          assert.deepEqual(scoreWindowsFromSamples(model, []), []);
          assert.throws(() => decodeWindowScores(model, samples, [], options), /dimensions/);
        }
      }
    }
  });
});
