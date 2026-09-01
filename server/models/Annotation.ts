import { getDb } from '@config/database';
import type {
  Annotation,
  CreateAnnotationData,
  SongPlayHistoryRow,
  UpdateAnnotationData
} from '@server/types';

export function create(data: CreateAnnotationData): number {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO annotations (file_id, song_name, start_time, end_time, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    data.fileId,
    data.songName,
    data.startTime,
    data.endTime,
    data.notes || null,
    now,
    now
  );

  return result.lastInsertRowid as number;
}

export function findByFileId(fileId: number): Annotation[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM annotations WHERE file_id = ? ORDER BY start_time ASC');
  return stmt.all(fileId) as Annotation[];
}

export function findById(id: number): Annotation | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as Annotation | undefined;
}

export function update(id: number, data: UpdateAnnotationData): boolean {
  const db = getDb();
  const updates: string[] = [];
  const values: any[] = [];

  if (data.songName !== undefined) {
    updates.push('song_name = ?');
    values.push(data.songName);
  }
  if (data.startTime !== undefined) {
    updates.push('start_time = ?');
    values.push(data.startTime);
  }
  if (data.endTime !== undefined) {
    updates.push('end_time = ?');
    values.push(data.endTime);
  }
  if (data.notes !== undefined) {
    updates.push('notes = ?');
    values.push(data.notes);
  }

  if (updates.length === 0) {
    return false;
  }

  updates.push('updated_at = ?');
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);

  const query = `UPDATE annotations SET ${updates.join(', ')} WHERE id = ?`;
  const result = db.prepare(query).run(...values);

  return result.changes > 0;
}

export function mergeOverlappingSameSong(id: number): Annotation | undefined {
  const db = getDb();
  const current = findById(id);
  if (!current) {
    return undefined;
  }

  const candidates = db.prepare(`
    SELECT *
    FROM annotations
    WHERE file_id = ?
      AND song_name = ?
      AND id != ?
    ORDER BY start_time ASC, end_time ASC, id ASC
  `).all(current.file_id, current.song_name, current.id) as Annotation[];

  let mergedStart = current.start_time;
  let mergedEnd = current.end_time;
  const idsToDelete = new Set<number>();

  // Grow the merged range until no additional overlaps are found.
  let didExpand = true;
  while (didExpand) {
    didExpand = false;
    for (const candidate of candidates) {
      if (idsToDelete.has(candidate.id)) continue;
      if (candidate.end_time <= mergedStart || candidate.start_time >= mergedEnd) {
        continue;
      }

      idsToDelete.add(candidate.id);
      mergedStart = Math.min(mergedStart, candidate.start_time);
      mergedEnd = Math.max(mergedEnd, candidate.end_time);
      didExpand = true;
    }
  }

  if (
    idsToDelete.size === 0
    && mergedStart === current.start_time
    && mergedEnd === current.end_time
  ) {
    return current;
  }

  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE annotations
      SET start_time = ?, end_time = ?, updated_at = ?
      WHERE id = ?
    `).run(mergedStart, mergedEnd, now, current.id);

      if (idsToDelete.size > 0) {
        const ids = [...idsToDelete];
        const placeholders = ids.map(() => '?').join(', ');
        // An absorbed annotation becomes part of the survivor, so reviews
        // promoted into it stay promoted and follow the merge. Run this
        // before the delete: the promoted_annotation_id foreign key
        // (ON DELETE SET NULL) would otherwise revert those reviews to
        // unpromoted and let a re-promote create a duplicate annotation.
      db.prepare(`
        UPDATE prediction_reviews
        SET promoted_annotation_id = ?, updated_at = ?
        WHERE promoted_annotation_id IN (${placeholders})
      `).run(current.id, now, ...ids);

      db.prepare(`DELETE FROM annotations WHERE id IN (${placeholders})`).run(...ids);
    }
  });

  tx();
  return findById(current.id);
}

export function remove(id: number): boolean {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const tx = db.transaction(() => {
    // Deleting the annotation a review was promoted into un-promotes that
    // review. Clear the promotion here rather than rely on the foreign key:
    // it nulls promoted_annotation_id but would leave promoted_at set for a
    // promotion that no longer exists.
    db.prepare(`
      UPDATE prediction_reviews
      SET promoted_annotation_id = NULL, promoted_at = NULL, updated_at = ?
      WHERE promoted_annotation_id = ?
    `).run(now, id);

    return db.prepare('DELETE FROM annotations WHERE id = ?').run(id).changes > 0;
  });

  return tx();
}

export function countByFileId(fileId: number): number {
  const db = getDb();
  const result = db.prepare('SELECT COUNT(*) as count FROM annotations WHERE file_id = ?').get(fileId) as { count: number };
  return result.count;
}

export function getUniqueSongNames(): string[] {
  const db = getDb();
  const results = db.prepare('SELECT DISTINCT song_name FROM annotations ORDER BY song_name ASC').all() as Array<{ song_name: string }>;
  return results.map(r => r.song_name);
}

/**
 * Count annotations created or edited after a unix timestamp. `updated_at`
 * is set on insert and edit, so this covers both new and changed rows since
 * the model was built.
 */
export function countChangedSince(timestamp: number): number {
  const db = getDb();
  const result = db.prepare('SELECT COUNT(*) as count FROM annotations WHERE updated_at > ?').get(timestamp) as { count: number };
  return result.count;
}

export function getTotalAnnotatedDuration(fileId: number): number {
  const db = getDb();
  const result = db.prepare(`
    SELECT SUM(end_time - start_time) as total_duration
    FROM annotations
    WHERE file_id = ?
  `).get(fileId) as { total_duration: number | null };

  return result.total_duration || 0;
}

export function getAnnotationsByFileId(fileId: number): Array<{ song_name: string; start_time: number }> {
  const db = getDb();
  const results = db.prepare(`
    SELECT song_name, start_time
    FROM annotations
    WHERE file_id = ?
    ORDER BY start_time ASC
  `).all(fileId) as Array<{ song_name: string; start_time: number }>;
  return results;
}

export function listRangesByFileId(fileId: number): Array<{ startTime: number; endTime: number }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT start_time, end_time
    FROM annotations
    WHERE file_id = ?
      AND end_time > start_time
    ORDER BY start_time ASC
  `).all(fileId) as Array<{ start_time: number; end_time: number }>;

  return rows.map((row) => ({
    startTime: row.start_time,
    endTime: row.end_time
  }));
}

export function getSongPlayHistory(): SongPlayHistoryRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      a.id AS annotation_id,
      a.file_id,
      a.song_name,
      a.start_time,
      a.end_time,
      f.filename,
      f.date_recorded,
      a.created_at,
      a.updated_at
    FROM annotations a
    JOIN files f ON f.id = a.file_id
    ORDER BY f.date_recorded DESC, a.start_time DESC, a.id DESC
  `).all() as SongPlayHistoryRow[];
}

export function renameSongName(oldSongName: string, newSongName: string): number {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    UPDATE annotations
    SET song_name = ?, updated_at = ?
    WHERE song_name = ?
  `).run(newSongName, now, oldSongName);
  return result.changes;
}
