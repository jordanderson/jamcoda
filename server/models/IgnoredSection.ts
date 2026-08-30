import { getDb } from '@config/database';
import type { CreateIgnoredSectionData, IgnoredSection } from '@server/types';

interface TimeRange {
  startTime: number;
  endTime: number;
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

export function create(data: CreateIgnoredSectionData): number {
  const db = getDb();
  const now = nowUnix();
  const result = db.prepare(`
    INSERT INTO ignored_sections (
      file_id,
      start_time,
      end_time,
      reason,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    data.fileId,
    data.startTime,
    data.endTime,
    data.reason ?? null,
    now,
    now
  );

  return result.lastInsertRowid as number;
}

export function findById(id: number): IgnoredSection | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM ignored_sections WHERE id = ?').get(id) as IgnoredSection | undefined;
}

export function findByFileId(fileId: number): IgnoredSection[] {
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM ignored_sections
    WHERE file_id = ?
    ORDER BY start_time ASC, id ASC
  `).all(fileId) as IgnoredSection[];
}

export function remove(id: number): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM ignored_sections WHERE id = ?').run(id);
  return result.changes > 0;
}

export function listRangesByFileId(fileId: number): TimeRange[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT start_time, end_time
    FROM ignored_sections
    WHERE file_id = ?
      AND end_time > start_time
    ORDER BY start_time ASC
  `).all(fileId) as Array<{ start_time: number; end_time: number }>;

  return rows.map((row) => ({
    startTime: row.start_time,
    endTime: row.end_time
  }));
}
