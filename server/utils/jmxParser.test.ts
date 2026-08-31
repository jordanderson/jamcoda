import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseJmxMetadata } from './jmxParser';

function vlq(value: number): number[] {
  if (value < 0x80) return [value];
  const bytes: number[] = [value & 0x7f];
  let remaining = value >> 7;
  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80);
    remaining >>= 7;
  }
  return bytes;
}

/** Build a minimal format-0 SMF with the given track bytes. */
function makeSmf(trackBytes: number[]): Buffer {
  const header = [
    ...Buffer.from('MThd', 'ascii'), 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xca,
    ...Buffer.from('MTrk', 'ascii'),
    (trackBytes.length >>> 24) & 0xff,
    (trackBytes.length >>> 16) & 0xff,
    (trackBytes.length >>> 8) & 0xff,
    trackBytes.length & 0xff
  ];
  return Buffer.from([...header, ...trackBytes]);
}

function meta7f(payload: number[]): number[] {
  return [0xff, 0x7f, ...vlq(payload.length), ...payload];
}

function bookmarkPayload(obj: Record<string, unknown>): number[] {
  return [0, ...Buffer.from(`jmxBookmark${JSON.stringify(obj)}\u0000`, 'ascii')];
}

function skipPayload(obj: Record<string, unknown>): number[] {
  return [0, ...Buffer.from(`jmxSkip${JSON.stringify(obj)}\u0000`, 'ascii')];
}

describe('parseJmxMetadata', () => {
  it('parses a bookmark with its playback position', () => {
    const track = [
      ...vlq(500), 0x90, 0x3c, 0x64, // note on after 500 ticks
      ...vlq(250),
      ...meta7f(bookmarkPayload({
        bookmarkIdx: 1,
        bookmarkUuid: 'bb5c9a0e-7a31-4d6f-8c22-91d04e3f7b62',
        bookmarkSource: 'byPianoTrigger',
        unixtime: 1745538005,
        localOffset: -420
      })),
      ...vlq(0), 0xff, 0x2f, 0
    ];
    const meta = parseJmxMetadata(makeSmf(track));

    assert.equal(meta.bookmarks?.length, 1);
    const bookmark = meta.bookmarks![0];
    assert.equal(bookmark.bookmarkIdx, 1);
    assert.equal(bookmark.bookmarkUuid, 'bb5c9a0e-7a31-4d6f-8c22-91d04e3f7b62');
    assert.equal(bookmark.bookmarkSource, 'byPianoTrigger');
    assert.equal(bookmark.unixtime, 1745538005);
    assert.equal(bookmark.localOffset, -420);
    // 500 + 250 ticks at 1ms/tick = 0.75s of playback time.
    assert.equal(bookmark.timeSec, 0.75);
  });

  it('accumulates positions across multiple bookmarks and channel events', () => {
    const track = [
      ...vlq(100), 0x90, 0x3c, 0x64,
      ...vlq(200), ...meta7f(bookmarkPayload({ bookmarkIdx: 0, bookmarkUuid: 'a' })),
      ...vlq(300), 0x80, 0x3c, 0x40,
      ...vlq(400), ...meta7f(bookmarkPayload({ bookmarkIdx: 1, bookmarkUuid: 'b' })),
      ...vlq(0), 0xff, 0x2f, 0
    ];
    const meta = parseJmxMetadata(makeSmf(track));

    assert.deepEqual(
      meta.bookmarks?.map((b) => [b.bookmarkIdx, b.timeSec]),
      [[0, 0.3], [1, 1.0]]
    );
  });

  it('returns no bookmarks for a file without them', () => {
    const track = [
      ...vlq(10), 0x90, 0x3c, 0x64,
      ...vlq(0), 0xff, 0x2f, 0
    ];
    const meta = parseJmxMetadata(makeSmf(track));
    assert.equal(meta.bookmarks, undefined);
  });

  it('parses jmxSkip silence gaps with duration and position', () => {
    const track = [
      ...vlq(100), 0x90, 0x3c, 0x64,
      ...vlq(250),
      ...meta7f(skipPayload({ millis: 15000, unixtime: 1745538005, localOffset: -420 })),
      ...vlq(0), 0xff, 0x2f, 0
    ];
    const meta = parseJmxMetadata(makeSmf(track));

    assert.equal(meta.skips?.length, 1);
    const skip = meta.skips![0];
    assert.equal(skip.millis, 15000);
    assert.equal(skip.unixtime, 1745538005);
    assert.equal(skip.localOffset, -420);
    // 100 + 250 ticks at 1ms/tick = 0.35s of playback time.
    assert.equal(skip.timeSec, 0.35);
  });

  it('drops malformed skip events that have no millis', () => {
    const track = [
      ...vlq(10), ...meta7f(skipPayload({})),
      ...vlq(0), 0xff, 0x2f, 0
    ];
    const meta = parseJmxMetadata(makeSmf(track));
    assert.equal(meta.skips, undefined);
  });

  it('ignores non-JMX buffers gracefully', () => {
    const meta = parseJmxMetadata(Buffer.from('not midi at all'));
    assert.deepEqual(meta, {});
  });
});