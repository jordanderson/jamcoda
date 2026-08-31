/**
 * Server-side types.
 *
 * Row shapes that cross the HTTP boundary live in `core/types` so the browser
 * client imports the same definitions instead of re-declaring them; they are
 * re-exported here so existing `@server/types` imports keep working.
 */
export type {
  Annotation,
  FileRecord,
  IgnoredSection,
  PredictionReview,
  PredictionReviewStatus,
  SongPlayHistoryRow
} from '@core/types';

import type { PredictionReview, PredictionReviewStatus } from '@core/types';

/** Payload used when creating a new synced file row. */
export interface CreateFileData {
  jamcorderPath: string;
  localPath: string;
  filename: string;
  fileSize: number;
  jamcorderModified: number;
  dateRecorded: string;
  midiDuration?: number | null;
  /** Stable asset identity from the JMX stone header. */
  assetUuid?: string | null;
  /** Byte offset of the JMX renewable trailer (for incremental re-sync). */
  jmxEofOffset?: number | null;
}

/** Payload for updating a re-synced file row. */
export interface UpdateSyncedFileData {
  fileSize?: number;
  jamcorderModified?: number;
  assetUuid?: string | null;
  jmxEofOffset?: number | null;
  midiDuration?: number | null;
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
  /** Non-fatal issues (e.g. skipped because the device copy is smaller). */
  warnings: Array<{ file: string; warning: string }>;
}

/** Jamcorder API file entry returned by remote directory listing calls. */
export interface JamcorderFileEntry {
  path: string;
  name: string;
  size: number;
  modified: number;
  type: 'file' | 'directory';
  /** Enrichment from the library API when available. */
  totalMillis?: number | null;
  isCurrentAsset?: boolean;
  assetIdx?: number;
}

/** Entry returned by POST /api/files/list/detailed. */
export interface JamcorderDetailedFile {
  filename: string;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedLocalTime: number;
}

/** Entry returned by POST /api/library/list/assets (the recording catalog). */
export interface JamcorderAsset {
  midiPath: string;
  dsel?: number;
  assetIdx?: number;
  isCurrentAsset?: boolean;
  filesize?: number;
  jmxEof?: {
    totalMillis?: number;
    totalNotes?: number;
    totalMsgs?: number;
    stoneOffsetPrev?: number;
    stoneIdxPrev?: number;
    stoneUuidPrev?: string;
  } | null;
}

/** Parsed JMX meta-event metadata. */
export interface JmxMetadata {
  assetUuid?: string;
  jamcorderUuid?: string;
  time?: string;
  assetIdx?: number;
  totalMillis?: number;
  eofFileOffset?: number;
}

/** Allowed review lifecycle states for prediction rows. */
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
