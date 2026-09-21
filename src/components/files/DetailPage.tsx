import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, Square, Plus, AlertCircle, Navigation, Flag, Sparkles, X } from 'lucide-react';
import { useFileDetail, useSetFileCompletion } from '@/hooks/useFileDetail';
import { useLocalFileDownload } from '@/hooks/useLocalFileDownload';
import { useMidiPlayer } from '@/hooks/useMidiPlayer';
import {
  useCreateAnnotation,
  useDeleteAnnotation,
  useUpdateAnnotation,
  useUniqueSongNames
} from '@/hooks/useAnnotations';
import { useAnnotationActions } from '@/hooks/useAnnotationActions';
import {
  usePredictionReviews,
  usePromotePredictionReview,
  useRunPredictionForFile,
  useUpdatePredictionReview
} from '@/hooks/usePredictionReviews';
import { PianoRollVisualizer } from '@/components/midi/PianoRollVisualizer';
import type {
  RollAnnotation,
  RollBookmark,
  RollSkip
} from '@/components/midi/pianoRollTypes';
import { AnnotationModal } from '@/components/annotations/AnnotationModal';
import { ToastStack } from '@/components/ui/ToastStack';
import { useToasts } from '@/hooks/useToasts';
import { useDetailShortcuts } from '@/hooks/useDetailShortcuts';
import type { PredictionReview } from '@/api/localTypes';
import { formatDate, formatTime } from '@/utils/format'
import { resolveReviewFields } from '@core/predictionReview';
import { snapSegmentBoundaries } from '@core/boundaries';
import {
  buildSoundingSpans,
  getSoundingGaps,
  LARGE_ANNOTATION_GAP_SECONDS,
  type AnnotationGap
} from './annotationGaps';
import { DetailAnnotationList } from './DetailAnnotationList';
import { DetailDeviceMarkers } from './DetailDeviceMarkers';
import {
  buildAcousticNotes,
  buildDeviceMarkers,
  buildPredictionSegments,
  MIN_SKIP_DISPLAY_SEC,
  resolveQueueModelVersion
} from './detailDerived';
import { PredictionLab } from './PredictionLab';
import { PredictionReviewModal } from './PredictionReviewModal';
import { FileOverview } from './FileOverview';
import type { CandidateRun } from './predictionCandidates';
import { errorMessage } from '@core/errors';

interface DetailPageProps {
  fileId: number;
}

interface AnnotationModalState {
  startTime: number;
  endTime: number;
  annotationId?: number;
  initialSongName?: string;
  mode?: 'create' | 'edit';
  /** Lets the reviewer type the bounds, for a range not marked on the roll. */
  allowTimeEdit?: boolean;
}

/** Default span for an annotation added without marking one on the roll. */
const NEW_ANNOTATION_SEC = 30;

const EMPTY_ANNOTATIONS: RollAnnotation[] = [];
const EMPTY_BOOKMARKS: RollBookmark[] = [];
const EMPTY_SKIPS: RollSkip[] = [];

/** The name shown for a review, honouring a reviewer's edit. */
const getPredictionDisplaySongName = (review: PredictionReview): string =>
  resolveReviewFields(review).songName

export function DetailPage({ fileId }: DetailPageProps) {
  const { data: file, isLoading, error } = useFileDetail(fileId);
  const { data: midiBlob, isLoading: isDownloading, error: downloadError } = useLocalFileDownload(fileId, !!file);
  const {
    play,
    pause,
    stop,
    loadMidi,
    seekTo,
    isPlaying,
    isLoaded,
    error: playerError,
    duration,
    currentTime,
    sequence
  } = useMidiPlayer();

  const createAnnotation = useCreateAnnotation();
  const deleteAnnotation = useDeleteAnnotation();
  const updateAnnotation = useUpdateAnnotation();
  const runPredictionForFile = useRunPredictionForFile();
  const updatePredictionReview = useUpdatePredictionReview();
  const promotePredictionReview = usePromotePredictionReview();
  const setFileCompletion = useSetFileCompletion();
  // Previewed Prediction Lab runs. They live here, not in the lab, so the
  // overview beside the piano roll can draw them against the notes. Nothing is
  // persisted: they are gone when this page is.
  const [candidateRuns, setCandidateRuns] = useState<CandidateRun[]>([]);
  const { data: reviewListResponse } = usePredictionReviews({
    fileId,
    includePromoted: false,
    limit: 500
  });
  const { data: uniqueSongNames = [] } = useUniqueSongNames();
  const { toasts, showToast, dismissToast, clearToasts } = useToasts();

  const [isAnnotationMode, setIsAnnotationMode] = useState(false);
  const [startCheckpoint, setStartCheckpoint] = useState<number | null>(null);
  const [endCheckpoint, setEndCheckpoint] = useState<number | null>(null);
  const [annotationModalData, setAnnotationModalData] = useState<AnnotationModalState | null>(null);
  const [snapToPlayback, setSnapToPlayback] = useState(true);
  const [selectedPredictionReviewId, setSelectedPredictionReviewId] = useState<number | null>(null);
  const [editingPredictionReviewId, setEditingPredictionReviewId] = useState<number | null>(null);
  const [hoveredRollTime, setHoveredRollTime] = useState<number | null>(null);
  const [loadedFileId, setLoadedFileId] = useState<number | null>(null);

  // ---------------------------------------------------------------------------
  // Derived data
  //
  // All memoised. This component re-renders every animation frame during
  // playback (the time readout depends on `currentTime`). An inline array
  // would be rebuilt sixty times a second and would hand a fresh identity to
  // children that could otherwise be skipped.
  // ---------------------------------------------------------------------------

  const annotations: RollAnnotation[] = file?.annotations ?? EMPTY_ANNOTATIONS;
  const bookmarks: RollBookmark[] = file?.bookmarks ?? EMPTY_BOOKMARKS;
  const skips: RollSkip[] = file?.skips ?? EMPTY_SKIPS;

  // Pedal-extended note spans for the whole file. Built once per sequence, not
  // once per annotation: this is the expensive half of gap detection, and
  // rebuilding it inside the loop below made a resize freeze the page for over
  // a second on an hour-long file.
  const soundingSpans = useMemo(
    () => (sequence?.notes ? buildSoundingSpans(sequence.notes, sequence.sustainEvents) : []),
    [sequence?.notes, sequence?.sustainEvents]
  );

  const annotationGapsById = useMemo(() => {
    const gapMap = new Map<number, AnnotationGap[]>();
    if (!sequence?.notes) {
      return gapMap;
    }

    for (const annotation of annotations) {
      gapMap.set(
        annotation.id,
        getSoundingGaps(
          soundingSpans,
          annotation.start_time,
          annotation.end_time,
          LARGE_ANNOTATION_GAP_SECONDS
        )
      );
    }

    return gapMap;
  }, [annotations, sequence?.notes, soundingSpans]);

  const acousticNotes = useMemo(() => buildAcousticNotes(sequence), [sequence]);

  const annotationActions = useAnnotationActions({
    acousticNotes,
    showToast,
    onRegionSplitDone: () => setAnnotationModalData(null)
  });

  // Whether any gap pill is shown at all, gating the helper copy above the
  // annotation list. Memoised: this component re-renders every frame during
  // playback.
  const hasGapPills = useMemo(
    () => [...annotationGapsById.values()].some((gaps) => gaps.length > 0),
    [annotationGapsById]
  );


  const deviceMarkers = useMemo(
    () => buildDeviceMarkers(bookmarks, skips),
    [bookmarks, skips]
  );

  const selectedPredictionReview = useMemo(() => {
    if (selectedPredictionReviewId === null) return null;
    return (reviewListResponse?.reviews ?? []).find(
      (review) => review.id === selectedPredictionReviewId
    ) ?? null;
  }, [reviewListResponse?.reviews, selectedPredictionReviewId]);

  /** The sequence's own end, used as a clamp for overlay times when valid. */
  const timelineEndLimit = useMemo(() => {
    const total = sequence?.totalTime;
    return typeof total === 'number' && Number.isFinite(total) && total > 0
      ? total
      : undefined;
  }, [sequence?.totalTime]);

  const queueModelVersion = useMemo(
    () => resolveQueueModelVersion(reviewListResponse?.reviews ?? []),
    [reviewListResponse?.reviews]
  );

  const predictionTimelineSegments = useMemo(
    () => buildPredictionSegments(reviewListResponse?.reviews ?? [], timelineEndLimit),
    [reviewListResponse?.reviews, timelineEndLimit]
  );


  // ---------------------------------------------------------------------------
  // Playback and view state
  // ---------------------------------------------------------------------------

  /** Seeking always re-engages follow, wherever the seek came from. */
  const handleSeek = useCallback((time: number) => {
    setSnapToPlayback(true);
    void seekTo(time);
  }, [seekTo]);

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      pause();
      return;
    }
    setSnapToPlayback(true);
    void play();
  }, [isPlaying, pause, play]);

  const handleMarkStart = useCallback(() => {
    setStartCheckpoint(currentTime);
  }, [currentTime]);

  const handleMarkEnd = useCallback(() => {
    setEndCheckpoint(currentTime);
  }, [currentTime]);

  const handleClearCheckpoints = useCallback(() => {
    setStartCheckpoint(null);
    setEndCheckpoint(null);
  }, []);

  /**
   * Load the downloaded MIDI into the player.
   *
   * Keyed on the blob, not on `isLoaded`. `loadMidi` reports a parse failure
   * by leaving `isLoaded` false rather than rejecting, so retrying on that
   * would re-parse an unreadable file on every render. Recording the blob we
   * attempted tries each one once.
   */
  const attemptedBlobRef = useRef<Blob | null>(null);
  useEffect(() => {
    if (!midiBlob || attemptedBlobRef.current === midiBlob) return;

    attemptedBlobRef.current = midiBlob;
    void loadMidi(midiBlob).then(() => {
      setLoadedFileId(fileId);
    });
  }, [midiBlob, loadMidi, fileId]);

  /**
   * Honour a `?time=` parameter once the player is ready for this file.
   *
   * Guarded on `loadedFileId`, not bare `isLoaded`, so a timer left from the
   * previous file cannot seek into this one. Clearing it on unmount keeps a
   * fast navigation from seeking a torn-down player.
   */
  useEffect(() => {
    if (!isLoaded || loadedFileId !== fileId) return;

    const queryStart = window.location.hash.indexOf('?');
    if (queryStart === -1) return;

    const timeParam = new URLSearchParams(
      window.location.hash.substring(queryStart + 1)
    ).get('time');
    if (timeParam === null) return;

    const startTime = parseFloat(timeParam);
    if (Number.isNaN(startTime)) return;

    // One tick of slack so the seek lands after the roll has laid out and can
    // scroll to it.
    const timer = setTimeout(() => handleSeek(startTime), 100);
    return () => clearTimeout(timer);
  }, [isLoaded, loadedFileId, fileId, handleSeek]);

  /**
   * Reset per-file view state when navigating to another recording.
   * Checkpoints, the follow toggle, region-select mode, and any queued toasts
   * all describe the file that was open, not the one being opened.
   */
  useEffect(() => {
    setStartCheckpoint(null);
    setEndCheckpoint(null);
    setIsAnnotationMode(false);
    setSnapToPlayback(true);
    setAnnotationModalData(null);
    setHoveredRollTime(null);
    setSelectedPredictionReviewId(null);
    clearToasts();
  }, [fileId, clearToasts]);

  // Drop the quick-review modal if its row disappears from under it.
  useEffect(() => {
    if (selectedPredictionReviewId !== null && !selectedPredictionReview) {
      setSelectedPredictionReviewId(null);
    }
  }, [selectedPredictionReviewId, selectedPredictionReview]);

  // Auto-open the annotation modal once both checkpoints are set.
  useEffect(() => {
    if (startCheckpoint === null || endCheckpoint === null) return;

    setAnnotationModalData({
      startTime: Math.min(startCheckpoint, endCheckpoint),
      endTime: Math.max(startCheckpoint, endCheckpoint)
    });
    handleClearCheckpoints();
  }, [startCheckpoint, endCheckpoint, handleClearCheckpoints]);

  useDetailShortcuts({
    isLoaded,
    hasCheckpoint: startCheckpoint !== null || endCheckpoint !== null,
    isModalOpen: annotationModalData !== null || selectedPredictionReviewId !== null,
    onPlayPause: handlePlayPause,
    onMarkStart: handleMarkStart,
    onMarkEnd: handleMarkEnd,
    onClearCheckpoints: handleClearCheckpoints
  });

  // ---------------------------------------------------------------------------
  // Annotation actions
  // ---------------------------------------------------------------------------

  /** Opens the modal on a span at the playhead, with the bounds editable. */
  const handleCreateAnnotation = useCallback(() => {
    const startTime = currentTime;
    const endTime = duration > 0
      ? Math.min(duration, startTime + NEW_ANNOTATION_SEC)
      : startTime + NEW_ANNOTATION_SEC;

    setAnnotationModalData({ startTime, endTime, mode: 'create', allowTimeEdit: true });
  }, [currentTime, duration]);

  const handleDeleteAnnotation = useCallback((annotationId: number) => {
    if (!confirm('Delete this annotation?')) return;
    deleteAnnotation.mutate(annotationId);
  }, [deleteAnnotation.mutate]);

  const handleRegionSelect = useCallback((startTime: number, endTime: number) => {
    setAnnotationModalData({ startTime, endTime });
    setIsAnnotationMode(false);
  }, []);


  const handleAnnotationSubmit = useCallback((
    songName: string,
    startTime?: number,
    endTime?: number
  ) => {
    if (!annotationModalData) return;

    if (annotationModalData.mode === 'edit' && annotationModalData.annotationId) {
      updateAnnotation.mutate({
        id: annotationModalData.annotationId,
        data: {
          songName,
          startTime: startTime ?? annotationModalData.startTime,
          endTime: endTime ?? annotationModalData.endTime
        }
      });
    } else {
      const finalStart = startTime ?? annotationModalData.startTime;
      const finalEnd = endTime ?? annotationModalData.endTime;
      createAnnotation.mutate({
        fileId,
        songName,
        startTime: finalStart,
        endTime: finalEnd
      }, {
        onSuccess: async () => {
          if (editingPredictionReviewId) {
            try {
              await updatePredictionReview.mutateAsync({
                id: editingPredictionReviewId,
                data: {
                  status: 'edited',
                  reviewedSongName: songName,
                  reviewedStartTime: finalStart,
                  reviewedEndTime: finalEnd
                }
              });
              await promotePredictionReview.mutateAsync(editingPredictionReviewId);
            } catch {
              // Annotation already safely created
            }
            setEditingPredictionReviewId(null);
          }
        }
      });
    }
    setAnnotationModalData(null);
  }, [annotationModalData, createAnnotation.mutate, editingPredictionReviewId, fileId, promotePredictionReview.mutateAsync, updateAnnotation.mutate, updatePredictionReview.mutateAsync]);

  const handleSnapTimes = useCallback((start: number, end: number) => {
    if (acousticNotes.length === 0) return { startTime: start, endTime: end };
    const snapped = snapSegmentBoundaries(start, end, acousticNotes, { trimFlourish: true });
    return { startTime: snapped.startTime, endTime: snapped.endTime };
  }, [acousticNotes]);

  const handleAnnotationCancel = useCallback(() => {
    setAnnotationModalData(null);
    setEditingPredictionReviewId(null);
  }, []);

  const handleEditAnnotation = useCallback((annotation: RollAnnotation) => {
    setAnnotationModalData({
      startTime: annotation.start_time,
      endTime: annotation.end_time,
      annotationId: annotation.id,
      initialSongName: annotation.song_name,
      mode: 'edit'
    });
  }, []);

  const splitCandidateAnnotation = useMemo(() => {
    if (!annotationModalData || annotationModalData.mode === 'edit') return null;
    const { startTime, endTime } = annotationModalData;
    return annotations.find(
      (ann) => ann.start_time < startTime && ann.end_time > endTime
    ) ?? null;
  }, [annotationModalData, annotations]);

  // ---------------------------------------------------------------------------
  // Prediction and completion actions
  // ---------------------------------------------------------------------------

  const handleRunPredictions = useCallback(() => {
    if (file?.isComplete) {
      showToast({
        type: 'error',
        message: 'This file is marked complete. Mark it incomplete to run predictions.'
      });
      return;
    }
    runPredictionForFile.mutate(
      { fileId },
      {
        onSuccess: (result) => {
          const created = result.insertedCount;
          const cleared = result.clearedCount;
          const baseMessage = created > 0
            ? `Generated ${created} prediction segment${created === 1 ? '' : 's'} for this file.`
            : 'No prediction segments were generated with current thresholds.';
          const clearMessage = cleared > 0
            ? ` Cleared ${cleared} previous unpromoted review row${cleared === 1 ? '' : 's'}.`
            : '';
          showToast({
            type: 'success',
            message: `${baseMessage}${clearMessage}`
          });
        },
        onError: (error) => {
          showToast({
            type: 'error',
            message: errorMessage(error, 'Failed to run predictions for this file.')
          });
        }
      }
    );
  }, [file?.isComplete, fileId, runPredictionForFile.mutate, showToast]);

  const handleOpenPredictionActionModal = useCallback((predictionId: number) => {
    setSelectedPredictionReviewId(predictionId);
  }, []);

  const handleClosePredictionActionModal = useCallback(() => {
    setSelectedPredictionReviewId(null);
  }, []);

  const handleConfirmAndPromoteReview = useCallback(async (review: PredictionReview) => {
    try {
      await updatePredictionReview.mutateAsync({
        id: review.id,
        data: { status: 'confirmed' }
      });
      await promotePredictionReview.mutateAsync(review.id);
      showToast({
        type: 'success',
        message: `Promoted "${getPredictionDisplaySongName(review)}" to annotations.`
      });
      if (selectedPredictionReviewId === review.id) {
        setSelectedPredictionReviewId(null);
      }
    } catch (error) {
      showToast({
        type: 'error',
        message: errorMessage(error, 'Failed to promote prediction.')
      });
    }
  }, [promotePredictionReview.mutateAsync, selectedPredictionReviewId, showToast, updatePredictionReview.mutateAsync]);

  const handleEditAndPromoteReview = useCallback((review: PredictionReview) => {
    const { songName, startTime, endTime } = resolveReviewFields(review);
    setAnnotationModalData({
      startTime,
      endTime,
      initialSongName: songName,
      mode: 'create'
    });
    setEditingPredictionReviewId(review.id);
    setSelectedPredictionReviewId(null);
  }, []);

  const handleMarkInvalidReview = useCallback(async (review: PredictionReview) => {
    try {
      await updatePredictionReview.mutateAsync({
        id: review.id,
        data: { status: 'invalid' }
      });
      showToast({ type: 'success', message: 'Prediction marked invalid.' });
      if (selectedPredictionReviewId === review.id) {
        setSelectedPredictionReviewId(null);
      }
    } catch (error) {
      showToast({
        type: 'error',
        message: errorMessage(error, 'Failed to mark prediction invalid.')
      });
    }
  }, [selectedPredictionReviewId, showToast, updatePredictionReview.mutateAsync]);

  const handleToggleFileCompletion = () => {
    if (!file) return;

    setFileCompletion.mutate(
      { fileId, isComplete: !file.isComplete },
      {
        onSuccess: (result) => {
          if (result.isComplete) {
            const cleared = result.clearedPredictionCount;
            showToast({
              type: 'success',
              message: `File marked complete. Cleared ${cleared} prediction row${cleared === 1 ? '' : 's'} for this file.`
            });
            return;
          }

          showToast({
            type: 'success',
            message: 'File marked incomplete. You can run predictions again for this file.'
          });
        },
        onError: (error) => {
          showToast({
            type: 'error',
            message: errorMessage(error, 'Failed to update file completion status.')
          });
        }
      }
    );
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#9198E5]"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-700">Error loading file: {errorMessage(error, 'Unknown error')}</p>
        </div>
      </div>
    );
  }

  if (!file) return null;

  const showError = downloadError || playerError;
  const showErrorMessage = showError instanceof Error
    ? showError.message
    : (typeof showError === 'string' ? showError : 'Failed to load MIDI file');
  // A failed parse leaves `isLoaded` false for good. The spinner cannot wait
  // on it; the error banner is the terminal state there.
  const loadingMidi = !showError && (isDownloading || (!!midiBlob && (!isLoaded || loadedFileId !== fileId)));
  const rollReady = !loadingMidi && isLoaded && !!sequence && loadedFileId === fileId;
  const isPredictionActionPending = (
    updatePredictionReview.isPending || promotePredictionReview.isPending
  );

  return (
    <div className="space-y-6">
      <AnnotationModal
        isOpen={annotationModalData !== null}
        fileId={fileId}
        startTime={annotationModalData?.startTime ?? 0}
        endTime={annotationModalData?.endTime ?? 0}
        existingSongNames={uniqueSongNames}
        onSubmit={handleAnnotationSubmit}
        onCancel={handleAnnotationCancel}
        initialSongName={annotationModalData?.initialSongName}
        mode={annotationModalData?.mode ?? 'create'}
        allowTimeEdit={
          annotationModalData?.mode === 'edit' || annotationModalData?.allowTimeEdit === true
        }
        onSnapTimes={handleSnapTimes}
        splitTargetAnnotation={splitCandidateAnnotation}
        onSplitAnnotation={annotationActions.splitAtRegion}
      />

      {selectedPredictionReview && (
        <PredictionReviewModal
          review={selectedPredictionReview}
          isPending={isPredictionActionPending}
          onClose={handleClosePredictionActionModal}
          onSeek={handleSeek}
          onConfirmAndPromote={(review) => { void handleConfirmAndPromoteReview(review); }}
          onEditAndPromote={handleEditAndPromoteReview}
          onMarkInvalid={(review) => { void handleMarkInvalidReview(review); }}
        />
      )}

      {/* File Info Header. One recording per day, so the date is the identity
          of the file; the filename adds nothing but is kept, quietly, because
          it is what the device and the logs call this recording. */}
      <div className="mb-3 flex items-baseline gap-2 flex-wrap">
        <h1 className="text-xl font-bold text-gray-900">{formatDate(file.dateRecorded)}</h1>
        {file.isComplete && (
          <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
            Complete
          </span>
        )}
        <span className="text-xs text-gray-400 font-mono truncate">{file.filename}</span>
      </div>

      {showError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-red-700 flex-shrink-0" />
          <p className="text-red-700">{showErrorMessage}</p>
        </div>
      )}

      {loadingMidi && (
        <div className="border rounded-lg overflow-hidden shadow-sm bg-white p-12 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900 mx-auto mb-4"></div>
          <p className="text-gray-600">{isDownloading ? 'Downloading MIDI file...' : 'Loading MIDI player...'}</p>
        </div>
      )}

      {/* Piano Roll */}
      {rollReady && (
        <div className="border rounded-lg overflow-hidden shadow-sm">
          <div className="bg-white p-4 border-b border-gray-200">
            {/* Transport, checkpoints and view controls on one row. Each
                button names its keyboard shortcut in its `title`. */}
            <div className="flex justify-between items-center gap-4 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={handlePlayPause}
                  className="w-8 h-8 rounded-full bg-gray-900 hover:bg-gray-800 text-white flex items-center justify-center transition-all"
                  title={isPlaying ? 'Pause (P)' : 'Play (P)'}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                </button>

                <button
                  onClick={stop}
                  className="w-8 h-8 rounded-full bg-gray-200 hover:bg-gray-300 text-gray-700 flex items-center justify-center transition-all"
                  title="Stop"
                  aria-label="Stop"
                >
                  <Square className="w-4 h-4" />
                </button>

                <div className="text-sm text-gray-600 font-medium min-w-[170px]">
                  {duration > 0
                    ? `${formatTime(currentTime)} (${currentTime.toFixed(1)}s) / ${formatTime(duration)}`
                    : '0:00 (0.0s) / 0:00'}
                </div>
                <div className="text-xs text-gray-500 min-w-[140px]">
                  {hoveredRollTime !== null
                    ? `Hover ${formatTime(hoveredRollTime)} (${hoveredRollTime.toFixed(1)}s)`
                    : 'Hover --'}
                </div>

                {isPlaying && (
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-green-50 text-green-700 rounded text-xs">
                    <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>
                    Playing
                  </div>
                )}
              </div>

              <div className="flex gap-2 items-center">
                <button
                  onClick={handleMarkStart}
                  disabled={!isLoaded}
                  className="px-3 py-1.5 bg-green-500 hover:bg-green-600 disabled:bg-green-300 disabled:cursor-not-allowed text-white rounded text-sm font-medium transition-colors flex items-center gap-1.5"
                  title="Mark start checkpoint (S)"
                >
                  <Flag className="w-3.5 h-3.5" />
                  Start
                  {startCheckpoint !== null && (
                    <span className="text-xs bg-white/30 px-1.5 py-0.5 rounded">
                      {formatTime(startCheckpoint)}
                    </span>
                  )}
                </button>

                <button
                  onClick={handleMarkEnd}
                  disabled={!isLoaded}
                  className="px-3 py-1.5 bg-red-500 hover:bg-red-600 disabled:bg-red-300 disabled:cursor-not-allowed text-white rounded text-sm font-medium transition-colors flex items-center gap-1.5"
                  title="Mark end checkpoint (E)"
                >
                  <Flag className="w-3.5 h-3.5" />
                  End
                  {endCheckpoint !== null && (
                    <span className="text-xs bg-white/30 px-1.5 py-0.5 rounded">
                      {formatTime(endCheckpoint)}
                    </span>
                  )}
                </button>

                {(startCheckpoint !== null || endCheckpoint !== null) && (
                  <button
                    onClick={handleClearCheckpoints}
                    className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-sm font-medium transition-colors flex items-center gap-1.5"
                    title="Clear checkpoints (C)"
                  >
                    <X className="w-3.5 h-3.5" />
                    Clear
                  </button>
                )}

                <button
                  onClick={() => setSnapToPlayback(true)}
                  disabled={snapToPlayback}
                  className={`px-3 py-1.5 rounded text-sm font-medium transition-all flex items-center gap-2 ${
                    snapToPlayback
                      ? 'bg-gray-900 text-white cursor-default'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                  title="Snap scroll to playback position"
                >
                  <Navigation className="w-4 h-4" />
                  {snapToPlayback ? 'Following' : 'Follow'}
                </button>
                <button
                  onClick={() => setIsAnnotationMode(!isAnnotationMode)}
                  className={`px-4 py-1.5 rounded text-sm font-medium transition-all ${
                    isAnnotationMode
                      ? 'bg-gray-900 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {isAnnotationMode ? 'Cancel Selection' : 'Select Region'}
                </button>
              </div>
            </div>

          </div>
          <div className="bg-white p-4">
            <PianoRollVisualizer
              sequence={sequence}
              currentTime={currentTime}
              isPlaying={isPlaying}
              annotations={annotations}
              predictions={predictionTimelineSegments}
              bookmarks={bookmarks}
              skips={skips}
              minSkipDisplaySec={MIN_SKIP_DISPLAY_SEC}
              startCheckpoint={startCheckpoint}
              endCheckpoint={endCheckpoint}
              onTimeClick={handleSeek}
              onRegionSelect={handleRegionSelect}
              isAnnotationMode={isAnnotationMode}
              snapToPlayback={snapToPlayback}
              onSnapToPlaybackChange={setSnapToPlayback}
              onHoverTimeChange={setHoveredRollTime}
              onPredictionClick={handleOpenPredictionActionModal}
              onAnnotationDelete={handleDeleteAnnotation}
              onAnnotationResize={annotationActions.resize}
            />
            <FileOverview
              durationSec={duration}
              currentTime={currentTime ?? 0}
              annotations={annotations}
              predictions={predictionTimelineSegments}
              candidates={candidateRuns}
              isFileComplete={Boolean(file.isComplete)}
              onSeek={handleSeek}
              onAnnotationResize={annotationActions.resize}
            />
            <DetailDeviceMarkers markers={deviceMarkers} onSeek={handleSeek} />
          </div>
        </div>
      )}

      <PredictionLab
        fileId={fileId}
        durationSec={duration}
        currentTime={currentTime ?? 0}
        annotations={annotations}
        currentPredictions={predictionTimelineSegments}
        isFileComplete={Boolean(file.isComplete)}
        queueModelVersion={queueModelVersion}
        runs={candidateRuns}
        onRunsChange={setCandidateRuns}
        onSeek={handleSeek}
        onError={(message) => showToast({ type: 'error', message })}
      />

      {/* Annotations */}
      <div className="border rounded-lg shadow-sm bg-white">
        <div className="p-6 border-b flex justify-between items-center">
          <h2 className="text-xl font-bold text-gray-900">
            Annotations ({annotations.length})
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleToggleFileCompletion}
              disabled={setFileCompletion.isPending}
              className={`px-4 py-2 rounded-lg transition-colors text-sm font-medium ${
                file.isComplete
                  ? 'bg-emerald-700 text-white hover:bg-emerald-800 disabled:bg-emerald-400'
                  : 'bg-gray-800 text-white hover:bg-gray-900 disabled:bg-gray-400'
              }`}
            >
              {setFileCompletion.isPending
                ? (file.isComplete ? 'Marking Incomplete...' : 'Marking Complete...')
                : (file.isComplete
                  ? 'Mark Incomplete'
                  : `Mark Complete (${file.percentageAnnotated}%)`)}
            </button>
            <button
              onClick={handleRunPredictions}
              disabled={runPredictionForFile.isPending || file.isComplete}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed transition-colors text-sm font-medium flex items-center gap-2"
            >
              <Sparkles className={`w-4 h-4 ${(runPredictionForFile.isPending && !file.isComplete) ? 'animate-pulse' : ''}`} />
              {file.isComplete ? 'File Complete' : (runPredictionForFile.isPending ? 'Running Predictions...' : 'Run Predictions')}
            </button>
            <button
              onClick={handleCreateAnnotation}
              className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors text-sm font-medium flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Add Annotation
            </button>
          </div>
        </div>

        <div className="p-6">
          {hasGapPills && (
            <p className="mb-4 text-xs text-gray-500">
              Gap pills show pauses of {LARGE_ANNOTATION_GAP_SECONDS}s or longer. Click a pill to jump, then use Trim or Snap to refine bounds.
            </p>
          )}
          <DetailAnnotationList
            annotations={annotations}
            gapsById={annotationGapsById}
            splittingGapKey={annotationActions.splittingGapKey}
            onSeek={handleSeek}
            onEdit={handleEditAnnotation}
            onDelete={handleDeleteAnnotation}
            onSplitGap={annotationActions.splitAtGap}
            onTrimGap={annotationActions.trimAtGap}
            onSnapBounds={annotationActions.snapBounds}
          />
        </div>
      </div>

      {/* Back Button */}
      <div>
        <button
          onClick={() => { window.location.hash = '/browse'; }}
          className="text-[#9198E5] hover:text-[#E66465] font-medium flex items-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to Library
        </button>
      </div>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
