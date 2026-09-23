import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { decodeWindowScores, type TrainConfig } from './songSegmentation';

const options = { minWindowConfidence: 0, smoothingWindows: 1 };
const config: TrainConfig = {
  windowSec: 6, stepSec: 1, k: 1, maxNoneToSongRatio: 1, decoder: 'anchor',
  minAnchorRun: 3, anchorMargin: 0.15, linkMaxSilenceRatio: 0.7
};
const left = [-10, -1, -5];
const right = [-10, -5, -1];
// Weak evidence favoring A for two windows, then B for four. The old
// left-to-right extension gives A all six despite B winning four of them.
const gap = [[-10, -2, -2.1], [-10, -2, -2.1], ...Array.from({ length: 4 }, () => [-10, -2.1, -2])];
const scores = [...Array(3).fill(left), ...gap, ...Array(3).fill(right)];

function decode(policy?: TrainConfig['anchorGapPolicy'], matrix = scores, silenceAt = -1) {
  const windows = matrix.map((_, i) => ({ startTime: i, endTime: i + 6,
    features: Array.from({ length: 37 }, (_, j) => j === 34 && i === silenceAt ? 1 : 0) }));
  return decodeWindowScores({ labels: ['__none__', 'A', 'B'], config: { ...config, anchorGapPolicy: policy } },
    windows, matrix, options).map((window) => window.label);
}

describe('experimental anchor gap competition', () => {
  it('records the existing early-song ownership and moves only the contested gap', () => {
    assert.deepEqual(decode(), [...Array(9).fill('A'), ...Array(3).fill('B')]);
    assert.deepEqual(decode('legacy'), decode());
    assert.deepEqual(decode('evidence'), [...Array(5).fill('A'), ...Array(7).fill('B')]);
    assert.deepEqual(decode('midpoint'), [...Array(6).fill('A'), ...Array(6).fill('B')]);
  });
  it('preserves silence barriers, same-song bridges and recording edges', () => {
    assert.deepEqual(decode('evidence', scores, 5), decode('legacy', scores, 5));
    const sameSong = [...Array(3).fill(left), ...gap, ...Array(3).fill(left)];
    assert.deepEqual(decode('evidence', sameSong), decode('legacy', sameSong));
    const edge = [...gap, ...Array(3).fill(right), ...gap];
    assert.deepEqual(decode('evidence', edge), decode('legacy', edge));
  });
  it('preserves strong none evidence and gives symmetric answers when evidence is reversed', () => {
    const blocked = scores.map((row, i) => i === 5 ? [-1, -10, -10] : row);
    assert.deepEqual(decode('evidence', blocked), decode('legacy', blocked));
    assert.deepEqual(decode('evidence', [...scores].reverse()).reverse(), decode('evidence'));
  });
});
