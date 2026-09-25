import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { scoreSessions, summarizeSessions } from './sessionEvaluation';

const session = (songName: string, startTime: number, endTime: number) => ({ songName, startTime, endTime });
const segment = (songName: string, startTime: number, endTime: number) =>
  ({ songName, startTime, endTime, durationSec: endTime - startTime, confidence: 0.5 });

describe('session scoring', () => {
  it('asks nothing of a prediction that matches the sessions', () => {
    const row = scoreSessions(1, [session('A', 10, 100)], [segment('A', 10, 100)], 120);
    assert.equal(row.correctSec, 90);
    assert.equal(row.unannotatedSec, 30);
    assert.equal(row.bleedSec, 0);
    assert.equal(row.reviewEdits, 0);
  });

  it('counts a prediction joining two sessions of one song as noodling called the song, and one split', () => {
    const row = scoreSessions(1, [session('A', 0, 100), session('A', 110, 200)], [segment('A', 0, 200)], 200);
    assert.equal(row.gapFillSec, 10);
    assert.equal(row.bleedSec, 10);
    assert.equal(row.sameSongGaps, 1);
    assert.equal(row.gapsBridged, 1);
    assert.equal(row.sessionsFound, 2);
    assert.equal(row.sessionsSplit, 0);
    assert.equal(row.reviewEdits, 1);
  });

  it('scores two annotations a pause apart as one session, with the pause part of it', () => {
    const row = scoreSessions(1, [session('A', 0, 100), session('A', 102, 200)], [segment('A', 0, 200)], 200);
    assert.equal(row.sessions, 1);
    assert.equal(row.sameSongGaps, 0);
    assert.equal(row.bleedSec, 0);
    assert.equal(row.correctSec, 200);
    assert.equal(row.reviewEdits, 0);
  });

  it('separates a session run long from a song that belongs to neither neighbor', () => {
    const row = scoreSessions(
      1,
      [session('A', 0, 100), session('C', 200, 300)],
      [segment('A', 0, 105), segment('B', 150, 170), segment('C', 195, 300)],
      300
    );
    assert.equal(row.overrunSec, 10);
    assert.equal(row.strayBleedSec, 20);
    assert.equal(row.gapFillSec, 0);
    assert.equal(row.unsupportedSegments, 1, 'the stray B segment is a delete');
  });

  it('counts wrong-song and missed time inside a session', () => {
    const row = scoreSessions(1, [session('A', 0, 100)], [segment('B', 0, 60)], 100);
    assert.equal(row.wrongSongSec, 60);
    assert.equal(row.missedSec, 40);
    assert.equal(row.sessionsFound, 0);
    assert.equal(row.unsupportedSegments, 1);
    assert.equal(row.reviewEdits, 2, 'a new annotation and a relabel or delete');
  });

  it('counts a session broken into two predictions as one merge', () => {
    const row = scoreSessions(1, [session('A', 0, 100)], [segment('A', 0, 40), segment('A', 50, 100)], 100);
    assert.equal(row.sessionsSplit, 1);
    assert.equal(row.missedSec, 10);
    assert.equal(row.reviewEdits, 1);
  });

  it('ignores a sliver of the same song when deciding a session was split', () => {
    const row = scoreSessions(1, [session('A', 0, 100)], [segment('A', 0, 98), segment('A', 98.5, 102)], 110);
    assert.equal(row.sessionsSplit, 0);
  });

  it('sums rows and reports shares', () => {
    const rows = [
      scoreSessions(1, [session('A', 0, 100), session('A', 110, 200)], [segment('A', 0, 200)], 200),
      scoreSessions(2, [session('B', 0, 50)], [], 100)
    ];
    const summary = summarizeSessions(rows);
    assert.equal(summary.files, 2);
    assert.equal(summary.annotatedSec, 240);
    assert.equal(summary.missedSec, 50);
    assert.equal(summary.reviewEdits, 2);
    assert.equal(summary.correctShare, 190 / 240);
    assert.equal(summary.bleedShare, 10 / 60);
  });

  it('bins same-song gaps by length, with how many were bridged', () => {
    const rows = [
      scoreSessions(1, [session('A', 0, 100), session('A', 104, 200), session('A', 220, 300)],
        [segment('A', 0, 200), segment('A', 220, 300)], 300)
    ];
    const bins = summarizeSessions(rows).gapsByLength;
    assert.deepEqual(bins.find((b) => b.fromSec === 3), { fromSec: 3, toSec: 6, gaps: 1, bridged: 1 });
    assert.deepEqual(bins.find((b) => b.fromSec === 12), { fromSec: 12, toSec: 30, gaps: 1, bridged: 0 });
    assert.equal(bins.at(-1)!.toSec, null);
  });

  it('splits predicted time by how the decoder reached it, and names what bridged each gap', () => {
    const bridging = {
      ...segment('A', 0, 200),
      parts: [
        { startTime: 0, endTime: 100, basis: 'anchor' as const },
        { startTime: 100, endTime: 110, basis: 'joined' as const },
        { startTime: 110, endTime: 200, basis: 'bridge' as const }
      ]
    };
    const row = scoreSessions(1, [session('A', 0, 100), session('A', 110, 200)], [bridging], 200);
    assert.deepEqual(row.timeByBasis.correct, { anchor: 100, bridge: 90 });
    assert.deepEqual(row.timeByBasis.gapFill, { joined: 10 });
    assert.equal(row.gaps[0].mainBasis, 'joined');
    assert.deepEqual(summarizeSessions([row]).bridgedGapsByBasis, { joined: 1 });
  });

  it('scores the stretches the review UI would flag, by how much of each is wrong', () => {
    const bridging = {
      ...segment('A', 0, 200),
      parts: [
        { startTime: 0, endTime: 98, basis: 'anchor' as const, meanRank: 0 },
        { startTime: 98, endTime: 112, basis: 'bridge' as const, meanRank: 5 },
        { startTime: 112, endTime: 200, basis: 'anchor' as const, meanRank: 0 }
      ]
    };
    const row = scoreSessions(1, [session('A', 0, 100), session('A', 110, 200)], [bridging], 200);
    assert.deepEqual(row.listenFlags, [{ lengthSec: 14, errorSec: 10 }]);
    assert.deepEqual(summarizeSessions([row]).listenFlags, { flags: 1, coveringError: 1 });
  });
});
