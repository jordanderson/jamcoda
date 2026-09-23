import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { decodeWindowScores, resolveTrainConfig, type TrainConfig } from './songSegmentation';

const options = { minWindowConfidence: 0, smoothingWindows: 1 };
const base: TrainConfig = {
  windowSec: 6, stepSec: 1, k: 1, maxNoneToSongRatio: 1, decoder: 'anchor',
  minAnchorRun: 3, anchorMargin: 0.15, linkMaxSilenceRatio: 0.7
};
// Enough songs for a rank to mean something: the rescue pass asks where a song
// sits in the ranking, which three labels cannot express.
const LABELS = ['__none__', 'A', 'B', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'];
const FILLER = [-3, -3, -3, -3, -3, -3, -3];
/** Filler that outranks a far-down A and B without ever beating `__none__`. */
const NEAR_FILLER = [-2.05, -2.06, -2.07, -2.08, -2.09, -2.10, -2.11];

const anchorA = [-10, -1, -5, ...FILLER];
const anchorB = [-10, -5, -1, ...FILLER];
// A third song, anchored strongly enough to block a fill it is too short to seed.
const anchorC = [-10, -5, -5, -1, -3, -3, -3, -3, -3, -3];
// Ambiguous, and both A and B are far down the ranking (8th and 9th of ten).
const vagueFar = [-2, -9, -9.1, ...NEAR_FILLER];
// Ambiguous, and B is the runner-up throughout while A stays far down.
const vagueTowardB = [-2, -9, -2.04, ...NEAR_FILLER];
// Ambiguous, with A the top label.
const vagueA = [-2.1, -2, -2.05, ...FILLER];
const runs = <T>(n: number, value: T) => Array.from({ length: n }, () => value);

function decode(config: Partial<TrainConfig>, matrix: number[][], silenceAt: number[] = []) {
  const windows = matrix.map((_, i) => ({
    startTime: i, endTime: i + 6,
    features: Array.from({ length: 37 }, (_, j) => (j === 34 && silenceAt.includes(i) ? 1 : 0))
  }));
  return decodeWindowScores({ labels: LABELS, config: { ...base, ...config } },
    windows, matrix, options).map((window) => window.label);
}

// A 3s leash with the rescue pass off, so each rule can be seen on its own.
const LEASH: Partial<TrainConfig> = { linkPolicy: 'bridge', linkTailSec: 3, linkRescueRank: -1 };
const BRIDGE: Partial<TrainConfig> = { linkPolicy: 'bridge', linkTailSec: 3 };
const transition = [...runs(3, anchorA), ...runs(10, vagueFar), ...runs(3, anchorB)];
const towardB = [...runs(3, anchorA), ...runs(10, vagueTowardB), ...runs(3, anchorB)];

describe('bridge linking', () => {
  it('leaves legacy linking untouched when absent or explicitly legacy', () => {
    // The finished song owns every ambiguous window up to the next anchor.
    assert.deepEqual(decode({}, transition), [...runs(13, 'A'), ...runs(3, 'B')]);
    assert.deepEqual(decode({ linkPolicy: 'legacy' }, transition), decode({}, transition));
    assert.deepEqual(decode({ linkPolicy: 'legacy', linkTailSec: 3 }, transition), decode({}, transition));
  });

  it('leashes both songs across a transition instead of giving the gap to the earlier one', () => {
    // Each side reaches 3 windows into the gap; the unexplained middle is left
    // unlabeled rather than assigned to whichever song came first.
    assert.deepEqual(decode(LEASH, transition),
      [...runs(6, 'A'), ...runs(4, '__none__'), ...runs(6, 'B')]);
  });

  it('gives the same answer when the recording is reversed', () => {
    const matrix = [...runs(3, anchorA), ...runs(9, vagueFar), ...runs(4, anchorB)];
    const swapAB = (row: number[]) => [row[0], row[2], row[1], ...row.slice(3)];
    const rename = (label: string) => (label === 'A' ? 'B' : label === 'B' ? 'A' : label);
    const mirrored = decode(LEASH, [...matrix].reverse().map(swapAB)).reverse().map(rename);
    assert.deepEqual(mirrored, decode(LEASH, matrix));
    // Legacy is not symmetric: it is exactly the bias this policy removes.
    assert.notDeepEqual(
      decode({}, [...matrix].reverse().map(swapAB)).reverse().map(rename),
      decode({}, matrix)
    );
  });

  it('does not leash a span that a second anchor run of the same song closes', () => {
    const inside = [...runs(3, anchorA), ...runs(10, vagueFar), ...runs(3, anchorA)];
    // Both ends vouch for the span, so it is a passage inside one take.
    assert.deepEqual(decode(LEASH, inside), runs(16, 'A'));
    assert.deepEqual(decode(LEASH, inside), decode({}, inside));
  });

  it('follows a tail past the leash only while the song stays the top choice', () => {
    const matrix = [...runs(3, anchorA), ...runs(10, vagueA), ...runs(3, anchorB)];
    // A is still the model's first choice through the gap, so it keeps going;
    // B only reaches its 3 leashed windows.
    assert.deepEqual(decode(LEASH, matrix), [...runs(10, 'A'), ...runs(6, 'B')]);
  });

  it('still treats silence as a barrier for both the leash and a vouched span', () => {
    // Silence one window into A's leash stops A there; B is unaffected.
    assert.deepEqual(decode(LEASH, transition, [4]),
      [...runs(4, 'A'), ...runs(6, '__none__'), ...runs(6, 'B')]);
    const inside = [...runs(3, anchorA), ...runs(10, vagueFar), ...runs(3, anchorA)];
    // A vouched span is filled from both ends and stops at the silent window.
    assert.deepEqual(decode(LEASH, inside, [8]),
      [...runs(8, 'A'), '__none__', ...runs(7, 'A')]);
  });

  it('does not leash a side with no other song to arbitrate against', () => {
    // The only anchored song in the recording: nothing competes for either
    // edge, so silence stays the only stop and this matches legacy.
    const alone = [...runs(6, vagueFar), ...runs(3, anchorA), ...runs(6, vagueFar)];
    assert.deepEqual(decode(LEASH, alone), runs(15, 'A'));
    assert.deepEqual(decode(LEASH, alone), decode({}, alone));
    // With B anchored later, A's right side is contested and leashed, while
    // A's left edge and B's right edge still run free.
    const pair = [...runs(6, vagueFar), ...runs(3, anchorA), ...runs(10, vagueFar),
      ...runs(3, anchorB), ...runs(6, vagueFar)];
    assert.deepEqual(decode(LEASH, pair),
      [...runs(12, 'A'), ...runs(4, '__none__'), ...runs(12, 'B')]);
  });
});

describe('span rescue', () => {
  it('gives a leashed-off span to the song the whole span favors, not the earlier one', () => {
    // B is the runner-up in every gap window while A sits 8th, so the middle
    // the leash left unlabeled belongs to B — though A reaches it first.
    assert.deepEqual(decode(BRIDGE, towardB), [...runs(6, 'A'), ...runs(10, 'B')]);
    // Legacy hands the same windows to A purely because it comes first.
    assert.deepEqual(decode({}, towardB), [...runs(13, 'A'), ...runs(3, 'B')]);
  });

  it('leaves a span alone when neither neighbor ranks well across it', () => {
    // Both songs sit 8th and 9th through the gap: dead air between takes.
    assert.deepEqual(decode(BRIDGE, transition), decode(LEASH, transition));
  });

  it('is on by default under bridge, off by default otherwise, and tunable', () => {
    assert.deepEqual(decode({ ...BRIDGE, linkRescueRank: 5 }, towardB), decode(BRIDGE, towardB));
    // A negative rank disables it, as with fillTopK.
    assert.deepEqual(decode({ ...BRIDGE, linkRescueRank: -1 }, towardB),
      [...runs(6, 'A'), ...runs(4, '__none__'), ...runs(6, 'B')]);
    // Rank 0 demands the outright top choice, which `__none__` holds here.
    assert.deepEqual(decode({ ...BRIDGE, linkRescueRank: 0 }, towardB),
      [...runs(6, 'A'), ...runs(4, '__none__'), ...runs(6, 'B')]);
    // Legacy linking does not run the pass unless it is asked for.
    assert.deepEqual(decode({ linkPolicy: 'legacy' }, towardB), decode({}, towardB));
  });

  it('does not claim silence, and splits a span at it', () => {
    // The silent window at 8 stays unlabeled and cuts the rescued span, so
    // only the part still touching B's segment is absorbed.
    assert.deepEqual(decode(BRIDGE, towardB, [8]),
      [...runs(6, 'A'), ...runs(3, '__none__'), ...runs(7, 'B')]);
  });
});

describe('bridge linking config resolution', () => {
  it('is what a model trains with unless legacy is asked for', () => {
    const resolved = resolveTrainConfig(base);
    assert.equal(resolved.linkPolicy, 'bridge');
    assert.equal(resolved.linkTailSec, 2);
    assert.equal(resolved.linkRescueRank, 5);

    // Legacy training must not record thresholds it never used: a model whose
    // policy were changed later would otherwise inherit stale values.
    const legacy = resolveTrainConfig({ ...base, linkPolicy: 'legacy' });
    assert.equal(legacy.linkPolicy, 'legacy');
    assert.equal(legacy.linkTailSec, undefined);
    assert.equal(legacy.linkRescueRank, undefined);

    const explicit = resolveTrainConfig({ ...base, linkPolicy: 'bridge', linkTailSec: 6, linkRescueRank: -1 });
    assert.equal(explicit.linkTailSec, 6);
    assert.equal(explicit.linkRescueRank, -1);
  });

  it('leaves a model saved before the default changed decoding as legacy', () => {
    // The default lives at fit time only. A stored config with no policy is a
    // model built under legacy linking, and the decoder must keep reading it
    // that way — a default must never move an existing model.
    for (const matrix of [transition, towardB]) {
      assert.deepEqual(decode({}, matrix), decode({ linkPolicy: 'legacy' }, matrix));
      assert.notDeepEqual(decode({}, matrix), decode({ linkPolicy: 'bridge' }, matrix));
    }
  });

  it('decodes a resolved config exactly as it decodes the unresolved one', () => {
    // The decoder repeats these defaults for configs that never went through
    // resolveTrainConfig. This is the guard against the two drifting.
    for (const matrix of [transition, towardB]) {
      assert.deepEqual(
        decode(resolveTrainConfig({ ...base, linkPolicy: 'bridge' }), matrix),
        decode({ linkPolicy: 'bridge' }, matrix)
      );
      assert.deepEqual(
        decode(resolveTrainConfig({ ...base, linkPolicy: 'legacy' }), matrix),
        decode({ linkPolicy: 'legacy' }, matrix)
      );
    }
  });
});

describe('span rescue lookahead', () => {
  // A span that favors B only in the windows nearest B. Averaged whole, B
  // fails the rank test and the span is abandoned; tested a few windows at a
  // time, B keeps the part it explains.
  const nearB = [...runs(3, anchorA), ...runs(14, vagueFar), ...runs(6, vagueTowardB),
    ...runs(3, anchorB)];

  it('claims only the part of a span a song explains', () => {
    // Whole-span mean: B ranks 9th across most of the 14 unlabeled windows,
    // so the leash result stands and every one of them is dropped.
    assert.deepEqual(decode(BRIDGE, nearB), decode(LEASH, nearB));
    // With a lookahead, B creeps back over the windows that do favor it and
    // stops where its evidence stops, instead of taking all or nothing.
    assert.deepEqual(decode({ ...BRIDGE, linkRescueLookaheadSec: 4 }, nearB),
      [...runs(6, 'A'), ...runs(12, '__none__'), ...runs(8, 'B')]);
  });

  it('is off by default, and a lookahead of 0 is the whole-span test', () => {
    for (const matrix of [transition, towardB, nearB]) {
      assert.deepEqual(decode({ ...BRIDGE, linkRescueLookaheadSec: 0 }, matrix),
        decode(BRIDGE, matrix));
    }
  });

  it('does not reopen a span a leash closed for want of evidence', () => {
    // Neither song ranks well anywhere in the gap: a lookahead must not turn
    // dead air into coverage just because it looks at less of it at a time.
    assert.deepEqual(decode({ ...BRIDGE, linkRescueLookaheadSec: 4 }, transition),
      decode(LEASH, transition));
  });

  it('still refuses a span between two takes of one song', () => {
    // A third song anchors too briefly to seed a run but blocks the vouched
    // fill from both sides. The span it leaves has A on both sides, which is
    // the break between two takes, so the rescue leaves it alone.
    const blocked = [...runs(3, anchorA), ...runs(4, vagueA), ...runs(2, anchorC),
      ...runs(4, vagueA), ...runs(3, anchorA)];
    assert.deepEqual(decode({ ...BRIDGE, linkRescueLookaheadSec: 4 }, blocked),
      [...runs(7, 'A'), ...runs(2, '__none__'), ...runs(7, 'A')]);
  });

  it('records the new field on a bridge model only', () => {
    assert.equal(resolveTrainConfig({ ...base, linkPolicy: 'legacy' }).linkRescueLookaheadSec, undefined);
    assert.equal(resolveTrainConfig(base).linkRescueLookaheadSec, 0);
    assert.equal(
      resolveTrainConfig({ ...base, linkPolicy: 'bridge', linkRescueLookaheadSec: 12 })
        .linkRescueLookaheadSec,
      12
    );
  });
});
