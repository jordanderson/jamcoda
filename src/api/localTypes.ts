/** Allowed status values for prediction review rows in the UI and API. */
export type PredictionReviewStatus = 'confirmed' | 'edited' | 'invalid' | 'unsure';

/** Raw prediction review row shape returned by local backend endpoints. */
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

/** Paginated prediction review list response. */
export interface PredictionReviewListResponse {
  reviews: PredictionReview[];
  total: number;
  limit: number;
  offset: number;
}

/** Queue-style review response used by low-confidence triage UIs. */
export interface PredictionReviewQueueResponse {
  reviews: PredictionReview[];
  limit: number;
}

/** Response after promoting a single review into annotations. */
export interface PromotePredictionReviewResponse {
  review: PredictionReview;
  annotationId: number;
  created: boolean;
}

/** Batch promotion response for all promotable reviewed rows. */
export interface PromoteReviewedPredictionReviewsResponse {
  attempted: number;
  promoted: Array<{
    reviewId: number;
    annotationId: number;
    created: boolean;
  }>;
  failed: Array<{
    reviewId: number;
    error: string;
  }>;
}

/** Request payload for merging multiple review rows. */
export interface MergePredictionReviewsRequest {
  reviewIds: number[];
}

/** Response payload returned from merge operation. */
export interface MergePredictionReviewsResponse {
  mergedReview: PredictionReview;
  mergedReviewId: number;
  mergedSongName: string;
  mergedStartTime: number;
  mergedEndTime: number;
  replacedReviewIds: number[];
  replacedCount: number;
}

/** Request body for running model prediction on one file. */
export interface RunPredictionForFileRequest {
  fileId: number;
  clearUnpromoted?: boolean;
  minWindowConfidence?: number;
  smoothingWindows?: number;
  minSegmentSec?: number;
  minSegmentConfidence?: number;
  mergeGapSec?: number;
  modelPath?: string;
}

/** Detailed response for prediction run stats and inserted rows. */
export interface RunPredictionForFileResponse {
  fileId: number;
  filename: string;
  modelVersion: string;
  config: {
    minWindowConfidence: number;
    smoothingWindows: number;
    minSegmentSec: number;
    minSegmentConfidence: number;
    mergeGapSec: number;
  };
  clearUnpromoted: boolean;
  clearedCount: number;
  insertedCount: number;
  segmentCount: number;
  annotatedRangeCount?: number;
  ignoredRangeCount?: number;
  excludedSegmentCount?: number;
  ignoredSegmentCount?: number;
}

/** Request body for rebuilding the segmentation model from annotations. */
export interface RebuildPredictionModelRequest {
  dbPath?: string;
  rootDir?: string;
  modelPath?: string;
  windowSec?: number;
  stepSec?: number;
  k?: number;
  maxNoneToSongRatio?: number;
  includeEvaluation?: boolean;
}

/** Response body for model rebuild, including training summary. */
export interface RebuildPredictionModelResponse {
  modelPath: string;
  modelVersion: string;
  config: {
    windowSec: number;
    stepSec: number;
    k: number;
    maxNoneToSongRatio: number;
  };
  filesUsed: number;
  annotationsUsed: number;
  trainingSummary: {
    filesUsed: number;
    annotationsUsed: number;
    totalSamples: number;
    positiveSamples: number;
    noneSamples: number;
    labelCounts: Record<string, number>;
  };
  labels: string[];
  evaluation: {
    folds: number;
    meanOverallAccuracy: number;
    meanSongAccuracy: number;
  } | null;
}

/** One annotated song segment used by the Songs page table/modal. */
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

/** Songs page list payload. */
export interface SongPlayHistoryResponse {
  songs: SongPlayHistoryRow[];
}

/** Global song-rename request payload. */
export interface RenameSongNameRequest {
  oldSongName: string;
  newSongName: string;
}

/** Global song-rename response with affected row counts. */
export interface RenameSongNameResponse {
  oldSongName: string;
  newSongName: string;
  annotationsUpdated: number;
  predictionReviewsPredictedUpdated: number;
  predictionReviewsReviewedUpdated: number;
}

/** Lightweight annotation summary embedded in files-by-date rows. */
export interface FileByDateAnnotationSummary {
  song_name: string;
  start_time: number;
}

/** One file row in the browse-by-date response. */
export interface FileByDateRow {
  id: number;
  filename: string;
  fileSize: number;
  dateRecorded: string;
  isComplete: boolean;
  completedAt: number | null;
  annotationCount: number;
  percentageAnnotated: number;
  totalDuration: number;
  annotatedDuration: number;
  annotations: FileByDateAnnotationSummary[];
  unreviewedPredictionCount: number;
}

/** One calendar date group in the browse response. */
export interface FilesByDateGroup {
  date: string;
  files: FileByDateRow[];
}

/** Browse page payload grouped by recording date. */
export interface FilesByDateResponse {
  dates: FilesByDateGroup[];
}

/** Annotation row shape embedded in file detail responses. */
export interface FileDetailAnnotation {
  id: number;
  file_id: number;
  song_name: string;
  start_time: number;
  end_time: number;
  notes?: string;
  created_at: number;
  updated_at: number;
}

/** Ignored section row shape embedded in file detail responses. */
export interface IgnoredSection {
  id: number;
  file_id: number;
  start_time: number;
  end_time: number;
  reason?: string;
  created_at: number;
  updated_at: number;
}

/** Standalone ignored-sections list response. */
export interface IgnoredSectionListResponse {
  sections: IgnoredSection[];
}

/** Request payload for creating an ignored section. */
export interface CreateIgnoredSectionRequest {
  fileId: number;
  startTime: number;
  endTime: number;
  reason?: string | null;
}

/** Response after creating an ignored section and clearing overlaps. */
export interface CreateIgnoredSectionResponse {
  section: IgnoredSection;
  clearedPredictionCount: number;
}

/** File detail response for detail page playback + annotation workflows. */
export interface FileDetailResponse {
  id: number;
  filename: string;
  dateRecorded: string;
  fileSize: number;
  localPath: string;
  jamcorderPath: string;
  syncedAt: number;
  isComplete: boolean;
  completedAt: number | null;
  annotations: FileDetailAnnotation[];
  ignoredSections: IgnoredSection[];
}

/** Request payload for toggling file completion state. */
export interface SetFileCompletionRequest {
  isComplete: boolean;
}

/** Response payload after completion toggle mutation. */
export interface SetFileCompletionResponse {
  id: number;
  isComplete: boolean;
  completedAt: number | null;
  clearedPredictionCount: number;
}
