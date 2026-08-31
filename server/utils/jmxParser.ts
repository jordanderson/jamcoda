import type { JmxMetadata } from '../types/index';

/**
 * Lightweight parser for Jamcorder JMX meta events embedded in a Standard MIDI
 * File. Extracts the fields this app needs for reliable sync:
 *
 * - `assetUuid` from `jmxStoneHdr` (stable asset identity recommended by the
 *   official JMX spec as the sync key, vs. path/filename which can change).
 * - `time` from `jmxAsset` (authoritative local recording date).
 * - `totalMillis` / `totalNotes` / `fileOffset` from `jmxEof` (silence-compressed
 *   duration, note count, and the byte offset of the renewable trailer, used for
 *   incremental re-sync and for recognising empty recordings).
 *
 * Returns an empty object for non-JMX or malformed files rather than throwing,
 * so callers can degrade gracefully.
 */
export function parseJmxMetadata(buffer: Buffer): JmxMetadata {
  const meta: JmxMetadata = {};

  if (buffer.length < 22 || buffer.subarray(0, 4).toString('ascii') !== 'MThd') {
    return meta;
  }

  const trackLen = buffer.readUInt32BE(18);
  const trackEnd = Math.min(22 + trackLen, buffer.length);
  let p = 22;

  while (p < trackEnd) {
    const delta = readVlq(buffer, p);
    p = delta.next;
    if (p >= trackEnd) break;

    const status = buffer[p++];

    if (status === 0xff) {
      const metaType = buffer[p++];
      const length = readVlq(buffer, p);
      p = length.next;
      const payload = buffer.subarray(p, p + length.value);
      p += length.value;
      parseJmxEvent(metaType, payload, meta);
    } else if (status === 0xf0 || status === 0xf7) {
      const length = readVlq(buffer, p);
      p = length.next + length.value;
    } else {
      const hi = status & 0xf0;
      p += hi === 0xc0 || hi === 0xd0 ? 1 : 2;
    }
  }

  return meta;
}

/** Convert a `jmxAsset.time` string (e.g. "2025-04-24 16:01:14 UTC-7") to YYYY-MM-DD. */
export function jmxTimeToDate(time: string): string | null {
  const match = time.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function parseJmxEvent(metaType: number, payload: Buffer, meta: JmxMetadata): void {
  if (metaType === 0x01 && payload.subarray(0, 8).toString('ascii') === 'jmxAsset') {
    const obj = parseJmxJson(payload.subarray(8));
    if (obj) {
      if (typeof obj.time === 'string') meta.time = obj.time;
      if (typeof obj.assetIdx === 'number') meta.assetIdx = obj.assetIdx;
    }
    return;
  }

  if (metaType === 0x7f && payload.length > 0 && payload[0] === 0x00) {
    const body = payload.subarray(1);
    const brace = body.indexOf(0x7b); // '{'
    if (brace < 0) return;
    const token = body.subarray(0, brace).toString('ascii');
    const obj = parseJmxJson(body.subarray(brace));
    if (!obj) return;

    if (token === 'jmxStoneHdr') {
      const asset = obj.asset as Record<string, unknown> | undefined;
      const identities = obj.identities as Record<string, unknown> | undefined;
      if (asset && typeof asset.assetUuid === 'string') meta.assetUuid = asset.assetUuid;
      if (identities && typeof identities.jamcorderUuid === 'string') {
        meta.jamcorderUuid = identities.jamcorderUuid;
      }
    } else if (token === 'jmxEof') {
      if (typeof obj.totalMillis === 'number') meta.totalMillis = obj.totalMillis;
      if (typeof obj.totalNotes === 'number') meta.totalNotes = obj.totalNotes;
      if (typeof obj.fileOffset === 'number') meta.eofFileOffset = obj.fileOffset;
    }
  }
}

/** Parse JMX JSON text (may be pretty-printed, terminates at the first NUL). */
function parseJmxJson(buf: Buffer): Record<string, unknown> | null {
  const start = buf.indexOf(0x7b); // '{'
  if (start < 0) return null;
  const end = buf.indexOf(0, start);
  const text = buf.subarray(start, end < 0 ? buf.length : end).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** SMF variable-length quantity: first byte is the most significant 7-bit group. */
function readVlq(buffer: Buffer, start: number): { value: number; next: number } {
  let value = 0;
  let i = start;
  while (i < buffer.length) {
    const b = buffer[i++];
    value = (value << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) break;
  }
  return { value, next: i };
}