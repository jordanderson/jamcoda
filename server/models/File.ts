import { getDb } from '@config/database';
import type { FileRecord, CreateFileData, UpdateSyncedFileData } from '@server/types';

export function create(data: CreateFileData): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO files (jamcorder_path, local_path, filename, file_size,
                       jamcorder_modified, synced_at, date_recorded, midi_duration,
                       asset_uuid, jmx_eof_offset)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    data.jamcorderPath,
    data.localPath,
    data.filename,
    data.fileSize,
    data.jamcorderModified,
    Math.floor(Date.now() / 1000),
    data.dateRecorded,
    data.midiDuration ?? null,
    data.assetUuid ?? null,
    data.jmxEofOffset ?? null
  );

  return result.lastInsertRowid as number;
}

export function existsByPath(jamcorderPath: string): boolean {
  const db = getDb();
  const stmt = db.prepare('SELECT id FROM files WHERE jamcorder_path = ?');
  return stmt.get(jamcorderPath) !== undefined;
}

export function findAll(): FileRecord[] {
  const db = getDb();
  return db.prepare('SELECT * FROM files').all() as FileRecord[];
}

export function findByDate(startDate?: string, endDate?: string): FileRecord[] {
  const db = getDb();
  let query = 'SELECT * FROM files';
  const params: string[] = [];

  if (startDate && endDate) {
    query += ' WHERE date_recorded BETWEEN ? AND ?';
    params.push(startDate, endDate);
  }

  query += ' ORDER BY date_recorded DESC, filename ASC';

  return db.prepare(query).all(...params) as FileRecord[];
}

export function findById(id: number): FileRecord | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRecord | undefined;
}

export function countAll(): number {
  const db = getDb();
  const result = db.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number };
  return result.count;
}

export function updateSyncMetadata(fileCount: number) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE sync_metadata
    SET last_sync_at = ?, last_sync_file_count = ?
    WHERE id = 1
  `);
  stmt.run(Math.floor(Date.now() / 1000), fileCount);
}

export function getSyncMetadata() {
  const db = getDb();
  return db.prepare('SELECT * FROM sync_metadata WHERE id = 1').get() as {
    id: number;
    last_sync_at: number | null;
    last_sync_file_count: number;
    high_water_asset_idx: number | null;
    high_water_jamcorder_uuid: string | null;
  };
}

export function updateSyncHighWater(assetIdx: number | null, jamcorderUuid: string | null) {
  const db = getDb();
  db.prepare(`
    UPDATE sync_metadata
    SET high_water_asset_idx = ?, high_water_jamcorder_uuid = ?
    WHERE id = 1
  `).run(assetIdx, jamcorderUuid);
}

export function setCompletion(id: number, isComplete: boolean): boolean {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    UPDATE files
    SET is_complete = ?, completed_at = ?
    WHERE id = ?
  `).run(
    isComplete ? 1 : 0,
    isComplete ? now : null,
    id
  );
  return result.changes > 0;
}

export function setMidiDuration(id: number, midiDuration: number): boolean {
  const db = getDb();
  const safeDuration = Number.isFinite(midiDuration) && midiDuration >= 0
    ? midiDuration
    : 0;
  const result = db.prepare(`
    UPDATE files
    SET midi_duration = ?
    WHERE id = ?
  `).run(safeDuration, id);
  return result.changes > 0;
}

export function updateSyncedFile(id: number, data: UpdateSyncedFileData): boolean {
  const db = getDb();
  const sets: string[] = [];
  const params: unknown[] = [];

  if (data.fileSize !== undefined) {
    sets.push('file_size = ?');
    params.push(data.fileSize);
  }
  if (data.jamcorderModified !== undefined) {
    sets.push('jamcorder_modified = ?');
    params.push(data.jamcorderModified);
  }
  if (data.assetUuid !== undefined) {
    sets.push('asset_uuid = ?');
    params.push(data.assetUuid ?? null);
  }
  if (data.jmxEofOffset !== undefined) {
    sets.push('jmx_eof_offset = ?');
    params.push(data.jmxEofOffset ?? null);
  }
  if (data.midiDuration !== undefined) {
    sets.push('midi_duration = ?');
    params.push(data.midiDuration ?? null);
  }

  if (sets.length === 0) {
    return false;
  }

  params.push(id);
  const result = db.prepare(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return result.changes > 0;
}
