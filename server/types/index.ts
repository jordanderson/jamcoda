/**
 * DB row stored in `files`.
 * Uses snake_case to match SQLite column names.
 */
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
}

/** Payload used when creating a new synced file row. */
export interface CreateFileData {
  jamcorderPath: string;
  localPath: string;
  filename: string;
  fileSize: number;
  jamcorderModified: number;
  dateRecorded: string;
  midiDuration?: number | null;
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

/** Payload for creating a new annotation segment. */
export interface CreateAnnotationData {
  fileId: number;
  songName: string;
  startTime: number;
  endTime: number;
  notes?: string;
}

/** Patch payload for updating an existing annotation. */
export interface UpdateAnnotationData {
  songName?: string;
  startTime?: number;
  endTime?: number;
  notes?: string;
}

/** Payload for creating an ignored time range for a file. */
export interface CreateIgnoredSectionData {
  fileId: number;
  startTime: number;
  endTime: number;
  reason?: string | null;
}

/** Response returned after globally renaming a song. */
export interface RenameSongNameResult {
  oldSongName: string;
  newSongName: string;
  annotationsUpdated: number;
  predictionReviewsPredictedUpdated: number;
  predictionReviewsReviewedUpdated: number;
}

/** Real-time sync status payload polled by the sync modal. */
export interface SyncProgress {
  syncId: string;
  status: 'in_progress' | 'completed' | 'error';
  filesFound: number;
  filesDownloaded: number;
  currentFile: string | null;
  errors: Array<{ file: string; error: string }>;
}

/** Jamcorder API file entry returned by remote directory listing calls. */
export interface JamcorderFileEntry {
  path: string;
  name: string;
  size: number;
  modified: number;
  type: 'file' | 'directory';
}

/** Allowed review lifecycle states for prediction rows. */
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

/** Payload for creating one prediction review row. */
export interface CreatePredictionReviewData {
  fileId: number;
  predictedSongName: string;
  predictedStartTime: number;
  predictedEndTime: number;
  predictedConfidence?: number | null;
  status?: PredictionReviewStatus;
  reviewedSongName?: string | null;
  reviewedStartTime?: number | null;
  reviewedEndTime?: number | null;
  reviewNotes?: string | null;
  modelVersion?: string | null;
}

/** Patch payload for updating review decision fields. */
export interface UpdatePredictionReviewData {
  status?: PredictionReviewStatus;
  reviewedSongName?: string | null;
  reviewedStartTime?: number | null;
  reviewedEndTime?: number | null;
  reviewNotes?: string | null;
  modelVersion?: string | null;
}

/** Optional filters for review listing endpoints/model queries. */
export interface ListPredictionReviewsFilters {
  fileId?: number;
  status?: PredictionReviewStatus;
  includePromoted?: boolean;
  limit?: number;
  offset?: number;
}

/** Result returned when promoting one review to annotations. */
export interface PromotePredictionReviewResult {
  review: PredictionReview;
  annotationId: number;
  created: boolean;
}

/** Result returned when merging multiple review rows into one. */
export interface MergePredictionReviewsResult {
  mergedReview: PredictionReview;
  mergedReviewId: number;
  mergedSongName: string;
  mergedStartTime: number;
  mergedEndTime: number;
  replacedReviewIds: number[];
  replacedCount: number;
}
