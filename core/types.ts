/**
 * Row shapes that cross the HTTP boundary.
 *
 * These live in `core/` because both the Express layer and the browser client
 * need the same definitions. Previously each side declared its own copy, which
 * had already drifted: `IgnoredSection.reason` was `string | null` on the
 * server and `reason?: string` in the client.
 *
 * Server-only payload types (the `Create...Data` / `Update...Data` shapes)
 * stay in `server/types`; these are strictly what gets serialized to JSON.
 *
 * Field names are snake_case to match the SQLite columns they come from.
 */

/** DB row stored in `files`. */
export interface FileRecord {
  id: number;
  jamcorder_path: string;
  local_path: string;
  filename: string;
  file_size: number;
  jamcorder_modified: number;
  synced_at: number;
  date_recorded: string;
  is_complete: number;
  completed_at: number | null;
  midi_duration: number | null;
  asset_uuid: string | null;
  jmx_eof_offset: number | null;
}

/** DB row stored in `annotations`. */
export interface Annotation {
  id: number;
  file_id: number;
  song_name: string;
  start_time: number;
  end_time: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

/** DB row stored in `ignored_sections`. */
export interface IgnoredSection {
  id: number;
  file_id: number;
  start_time: number;
  end_time: number;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Flattened annotation + file metadata used by the Songs page.
 * Represents one playable annotated segment.
 */
export interface SongPlayHistoryRow {
  annotation_id: number;
  file_id: number;
  song_name: string;
  start_time: number;
  end_time: number;
  filename: string;
  date_recorded: string;
  created_at: number;
  updated_at: number;
}

export type PredictionReviewStatus = 'confirmed' | 'edited' | 'invalid' | 'unsure';

/** DB row stored in `prediction_reviews`. */
export interface PredictionReview {
  id: number;
  file_id: number;
  predicted_song_name: string;
  predicted_start_time: number;
  predicted_end_time: number;
  predicted_confidence: number | null;
  status: PredictionReviewStatus;
  reviewed_song_name: string | null;
  reviewed_start_time: number | null;
  reviewed_end_time: number | null;
  review_notes: string | null;
  model_version: string | null;
  promoted_annotation_id: number | null;
  created_at: number;
  updated_at: number;
  reviewed_at: number | null;
  promoted_at: number | null;
}
