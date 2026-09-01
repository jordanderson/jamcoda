import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, Square, Plus, AlertCircle, Navigation, Flag, Sparkles, X } from 'lucide-react';
import { useFileDetail, useSetFileCompletion } from '@/hooks/useFileDetail';
import { useLocalFileDownload } from '@/hooks/useLocalFileDownload';
import { useMidiPlayer } from '@/hooks/useMidiPlayer';
import {
  useCreateAnnotation,
  useCreateIgnoredSection,
  useDeleteAnnotation,
  useDeleteIgnoredSection,
  useUpdateAnnotation,
  useUniqueSongNames
} from '@/hooks/useAnnotations';
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
  RollIgnoredSection,
  RollPrediction,
  RollSkip
} from '@/components/midi/pianoRollTypes';
import { AnnotationModal } from '@/components/annotations/AnnotationModal';
import type { PredictionReview } from '@/api/localTypes';
import { formatTime, formatTimeHms } from '@/utils/format'
import { resolveReviewFields } from '@core/predictionReview';
import {
  getGapAction,
  getLargeAnnotationGaps,
  LARGE_ANNOTATION_GAP_SECONDS,
  type AnnotationGap
} from './annotationGaps';
import { DetailAnnotationList } from './DetailAnnotationList';
import { DetailDeviceMarkers, type DeviceMarker } from './DetailDeviceMarkers';
import { DetailIgnoredSections } from './DetailIgnoredSections';

interface DetailPageProps {
  fileId: number;
}

interface Feedback {
  type: 'success' | 'error';
  message: string;
}

interface AnnotationModalState {
  startTime: number;
  endTime: number;
  annotationId?: number;
  initialSongName?: string;
  mode?: 'create' | 'edit';
  initialAction?: 'annotation' | 'ignored';
}

/** Device silence gaps shorter than this are noise, not passage boundaries. */
const MIN_SKIP_DISPLAY_SEC = 8;

const EMPTY_ANNOTATIONS: RollAnnotation[] = [];
const EMPTY_BOOKMARKS: RollBookmark[] = [];
const EMPTY_SKIPS: RollSkip[] = [];

// Thin adapters over the shared resolver so call sites stay readable.
const getPredictionDisplaySongName = (review: PredictionReview): string => resolveReviewFields(review).songName
const getPredictionDisplayStart = (review: PredictionReview): number => resolveReviewFields(review).startTime
const getPredictionDisplayEnd = (review: PredictionReview): number => resolveReviewFields(review).endTime

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
  const createIgnoredSection = useCreateIgnoredSection();
  const deleteIgnoredSection = useDeleteIgnoredSection();
  const deleteAnnotation = useDeleteAnnotation();
  const updateAnnotation = useUpdateAnnotation();
  const runPredictionForFile = useRunPredictionForFile();
  const updatePredictionReview = useUpdatePredictionReview();
  const promotePredictionReview = usePromotePredictionReview();
  const setFileCompletion = useSetFileCompletion();
  const { data: reviewListResponse } = usePredictionReviews({
    fileId,
    includePromoted: false,
    limit: 500
  });
  const { data: uniqueSongNames = [] } = useUniqueSongNames();

  const [isAnnotationMode, setIsAnnotationMode] = useState(false);
  const [startCheckpoint, setStartCheckpoint] = useState<number | null>(null);
  const [endCheckpoint, setEndCheckpoint] = useState<number | null>(null);
  const [annotationModalData, setAnnotationModalData] = useState<AnnotationModalState | null>(null);
  const [snapToPlayback, setSnapToPlayback] = useState(true);
  const [predictionFeedback, setPredictionFeedback] = useState<Feedback | null>(null);
  const [completionFeedback, setCompletionFeedback] = useState<Feedback | null>(null);
  const [predictionReviewFeedback, setPredictionReviewFeedback] = useState<Feedback | null>(null);
  const [selectedPredictionReviewId, setSelectedPredictionReviewId] = useState<number | null>(null);
  const [hoveredRollTime, setHoveredRollTime] = useState<number | null>(null);
  const [annotationFeedback, setAnnotationFeedback] = useState<Feedback | null>(null);
  const [ignoredSectionFeedback, setIgnoredSectionFeedback] = useState<Feedback | null>(null);
  const [splittingGapKey, setSplittingGapKey] = useState<string | null>(null);
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

  const annotationGapsById = useMemo(() => {
    const gapMap = new Map<number, AnnotationGap[]>();
    if (!sequence?.notes) {
      return gapMap;
    }

    for (const annotation of annotations) {
      gapMap.set(
        annotation.id,
        getLargeAnnotationGaps(
          annotation.start_time,
          annotation.end_time,
          sequence.notes,
          LARGE_ANNOTATION_GAP_SECONDS
        )
      );
    }

    return gapMap;
  }, [annotations, sequence?.notes]);

  const ignoredSections = useMemo(() => {
    return [...(file?.ignoredSections ?? [])]
      .filter((section) => section.end_time > section.start_time)
      .sort((a, b) => a.start_time - b.start_time || a.id - b.id);
  }, [file?.ignoredSections]);

  const deviceMarkers = useMemo<DeviceMarker[]>(() => {
    const bookmarkMarkers = bookmarks.map((bookmark) => ({
      key: `bm-${bookmark.bookmarkIdx}`,
      timeSec: bookmark.timeSec,
      kind: 'bookmark' as const,
      label: `BM ${bookmark.bookmarkIdx} · ${formatTimeHms(bookmark.timeSec)}`
    }));
    const skipMarkers = skips
      .filter((skip) => skip.millis >= MIN_SKIP_DISPLAY_SEC * 1000)
      .map((skip, index) => ({
        key: `skip-${skip.timeSec.toFixed(3)}-${index}`,
        timeSec: skip.timeSec,
        kind: 'skip' as const,
        label: formatTimeHms(skip.timeSec),
        gapSec: Math.round(skip.millis / 1000)
      }));
    return [...bookmarkMarkers, ...skipMarkers].sort((a, b) => a.timeSec - b.timeSec);
  }, [bookmarks, skips]);

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

  const predictionTimelineSegments = useMemo<RollPrediction[]>(() => {
    return (reviewListResponse?.reviews ?? [])
      .filter((review) => review.status !== 'invalid')
      .map((review) => {
        const { songName, startTime, endTime } = resolveReviewFields(review);

        if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
          return null;
        }

        return {
          id: review.id,
          songName,
          startTime: Math.max(0, startTime),
          endTime: timelineEndLimit !== undefined ? Math.min(timelineEndLimit, endTime) : endTime,
          confidence: review.predicted_confidence ?? null
        };
      })
      .filter((segment): segment is RollPrediction => (
        segment !== null && segment.endTime > segment.startTime
      ))
      .sort((a, b) => a.startTime - b.startTime || a.id - b.id);
  }, [reviewListResponse?.reviews, timelineEndLimit]);

  const ignoredTimelineSegments = useMemo<RollIgnoredSection[]>(() => {
    return ignoredSections.reduce<RollIgnoredSection[]>((segments, section) => {
      if (!Number.isFinite(section.start_time) || !Number.isFinite(section.end_time)) {
        return segments;
      }

      const startTime = Math.max(0, section.start_time);
      const endTime = timelineEndLimit !== undefined
        ? Math.min(timelineEndLimit, section.end_time)
        : section.end_time;

      if (endTime <= startTime) {
        return segments;
      }

      segments.push({
        id: section.id,
        startTime,
        endTime,
        reason: section.reason ?? undefined
      });
      return segments;
    }, []);
  }, [ignoredSections, timelineEndLimit]);

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
   * Checkpoints, the follow toggle, region-select mode, and the feedback
   * banners all describe the file that was open, not the one being opened.
   */
  useEffect(() => {
    setStartCheckpoint(null);
    setEndCheckpoint(null);
    setIsAnnotationMode(false);
    setSnapToPlayback(true);
    setAnnotationModalData(null);
    setHoveredRollTime(null);
    setSelectedPredictionReviewId(null);
    setSplittingGapKey(null);
    setPredictionFeedback(null);
    setPredictionReviewFeedback(null);
    setCompletionFeedback(null);
    setAnnotationFeedback(null);
    setIgnoredSectionFeedback(null);
  }, [fileId]);

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
      endTime: Math.max(startCheckpoint, endCheckpoint),
      initialAction: 'annotation'
    });
    handleClearCheckpoints();
  }, [startCheckpoint, endCheckpoint, handleClearCheckpoints]);

  /**
   * Latest values for the keyboard handler, read through a ref so the window
   * listener is subscribed once. Depending on `currentTime` directly would
   * tear it down and re-add it on every animation frame during playback.
   */
  const shortcutsRef = useRef({
    isLoaded,
    hasCheckpoint: false,
    isModalOpen: false,
    handlePlayPause,
    handleMarkStart,
    handleMarkEnd,
    handleClearCheckpoints
  });
  useEffect(() => {
    shortcutsRef.current = {
      isLoaded,
      hasCheckpoint: startCheckpoint !== null || endCheckpoint !== null,
      isModalOpen: annotationModalData !== null || selectedPredictionReviewId !== null,
      handlePlayPause,
      handleMarkStart,
      handleMarkEnd,
      handleClearCheckpoints
    };
  });

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Not while typing, and not while a modal owns the screen. Otherwise
      // these would act on the piano roll hidden behind it.
      const target = e.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      const shortcuts = shortcutsRef.current;
      if (shortcuts.isModalOpen) return;

      // Leave browser and OS chords (cmd+P print, ctrl+S save) alone.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key.toLowerCase()) {
        case 'p':
          if (!shortcuts.isLoaded) return;
          // Space already scrolls the page. P is the unambiguous binding.
          e.preventDefault();
          shortcuts.handlePlayPause();
          return;
        case 's':
          shortcuts.handleMarkStart();
          return;
        case 'e':
          shortcuts.handleMarkEnd();
          return;
        case 'c':
          if (shortcuts.hasCheckpoint) shortcuts.handleClearCheckpoints();
          return;
        default:
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, []);

  // ---------------------------------------------------------------------------
  // Annotation actions
  // ---------------------------------------------------------------------------

  const handleCreateAnnotation = useCallback(() => {
    const startTimeStr = prompt('Enter start time (seconds):');
    const endTimeStr = prompt('Enter end time (seconds):');

    if (!startTimeStr || !endTimeStr) return;

    const startTime = parseFloat(startTimeStr);
    const endTime = parseFloat(endTimeStr);

    if (isNaN(startTime) || isNaN(endTime) || startTime >= endTime) {
      alert('Invalid time values');
      return;
    }

    setAnnotationModalData({ startTime, endTime, initialAction: 'annotation' });
  }, []);

  const handleSubmitIgnoredSection = useCallback(async (
    startTime: number,
    endTime: number,
    reason?: string
  ) => {
    setIgnoredSectionFeedback(null);

    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
      setIgnoredSectionFeedback({
        type: 'error',
        message: 'Start and end times must be valid numbers.'
      });
      return;
    }

    if (startTime >= endTime) {
      setIgnoredSectionFeedback({
        type: 'error',
        message: 'Start time must be less than end time.'
      });
      return;
    }

    if (startTime < 0) {
      setIgnoredSectionFeedback({
        type: 'error',
        message: 'Start time cannot be negative.'
      });
      return;
    }

    if (duration > 0 && endTime > duration + 0.001) {
      setIgnoredSectionFeedback({
        type: 'error',
        message: `End time must be within file duration (${formatTime(duration)}).`
      });
      return;
    }

    try {
      const result = await createIgnoredSection.mutateAsync({
        fileId,
        startTime,
        endTime,
        reason: reason?.trim() || null
      });

      const cleared = result.clearedPredictionCount;
      const clearedMessage = cleared > 0
        ? ` Cleared ${cleared} overlapping unpromoted prediction row${cleared === 1 ? '' : 's'}.`
        : '';
      setIgnoredSectionFeedback({
        type: 'success',
        message: `Ignored section added.${clearedMessage}`
      });
      setAnnotationModalData(null);
    } catch (error) {
      setIgnoredSectionFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to add ignored section.'
      });
    }
  }, [createIgnoredSection.mutateAsync, duration, fileId]);

  const handleDeleteIgnoredSection = useCallback((ignoredSectionId: number) => {
    if (!confirm('Delete this ignored section?')) return;

    setIgnoredSectionFeedback(null);
    deleteIgnoredSection.mutate(ignoredSectionId, {
      onSuccess: () => {
        setIgnoredSectionFeedback({ type: 'success', message: 'Ignored section deleted.' });
      },
      onError: (error) => {
        setIgnoredSectionFeedback({
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to delete ignored section.'
        });
      }
    });
  }, [deleteIgnoredSection.mutate]);

  const handleDeleteAnnotation = useCallback((annotationId: number) => {
    if (!confirm('Delete this annotation?')) return;
    setAnnotationFeedback(null);
    deleteAnnotation.mutate(annotationId);
  }, [deleteAnnotation.mutate]);

  const handleRegionSelect = useCallback((startTime: number, endTime: number) => {
    setAnnotationModalData({ startTime, endTime, initialAction: 'annotation' });
    setIsAnnotationMode(false);
  }, []);

  const handleIgnoredSectionClick = useCallback((ignoredSectionId: number) => {
    const section = ignoredSections.find((item) => item.id === ignoredSectionId);
    if (!section) return;
    handleSeek((section.start_time + section.end_time) / 2);
  }, [handleSeek, ignoredSections]);

  const handleAnnotationResize = useCallback(async (
    annotationId: number,
    times: { startTime: number; endTime: number }
  ) => {
    setAnnotationFeedback(null);

    if (!Number.isFinite(times.startTime) || !Number.isFinite(times.endTime)) {
      const error = new Error('Resized annotation has invalid time values.');
      setAnnotationFeedback({ type: 'error', message: error.message });
      throw error;
    }
    if (times.startTime >= times.endTime) {
      const error = new Error('Annotation start time must be less than end time.');
      setAnnotationFeedback({ type: 'error', message: error.message });
      throw error;
    }

    try {
      await updateAnnotation.mutateAsync({
        id: annotationId,
        data: { startTime: times.startTime, endTime: times.endTime }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to resize annotation.';
      setAnnotationFeedback({ type: 'error', message });
      throw error;
    }
  }, [updateAnnotation.mutateAsync]);

  const handleAnnotationSubmit = useCallback((
    songName: string,
    startTime?: number,
    endTime?: number
  ) => {
    setAnnotationFeedback(null);
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
      createAnnotation.mutate({
        fileId,
        songName,
        startTime: annotationModalData.startTime,
        endTime: annotationModalData.endTime
      });
    }
    setAnnotationModalData(null);
  }, [annotationModalData, createAnnotation.mutate, fileId, updateAnnotation.mutate]);

  const handleAnnotationCancel = useCallback(() => {
    setAnnotationModalData(null);
  }, []);

  const handleEditAnnotation = useCallback((annotation: RollAnnotation) => {
    setAnnotationFeedback(null);
    setAnnotationModalData({
      startTime: annotation.start_time,
      endTime: annotation.end_time,
      annotationId: annotation.id,
      initialSongName: annotation.song_name,
      mode: 'edit',
      initialAction: 'annotation'
    });
  }, []);

  const handleSplitAnnotationGap = useCallback(async (
    annotation: RollAnnotation,
    gap: AnnotationGap,
    gapIndex: number
  ) => {
    if (getGapAction(gap, annotation) !== 'split') {
      setAnnotationFeedback({
        type: 'error',
        message: 'This gap is at the edge of the annotation and cannot be split into two segments.'
      });
      return;
    }

    const splitKey = `${annotation.id}:${gapIndex}`;
    setSplittingGapKey(splitKey);
    setAnnotationFeedback(null);

    const originalStart = annotation.start_time;
    const originalEnd = annotation.end_time;

    try {
      await updateAnnotation.mutateAsync({
        id: annotation.id,
        data: { startTime: originalStart, endTime: gap.startTime }
      });

      try {
        await createAnnotation.mutateAsync({
          fileId,
          songName: annotation.song_name,
          startTime: gap.endTime,
          endTime: originalEnd
        });
      } catch (createError) {
        await updateAnnotation.mutateAsync({
          id: annotation.id,
          data: { startTime: originalStart, endTime: originalEnd }
        });
        throw new Error(
          createError instanceof Error
            ? `Split failed while creating second segment. Original annotation was restored. ${createError.message}`
            : 'Split failed while creating second segment. Original annotation was restored.'
        );
      }

      setAnnotationFeedback({
        type: 'success',
        message: `Split annotation at gap ${formatTime(gap.startTime)} - ${formatTime(gap.endTime)}.`
      });
    } catch (error) {
      setAnnotationFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to split annotation at this gap.'
      });
    } finally {
      setSplittingGapKey((current) => (current === splitKey ? null : current));
    }
  }, [createAnnotation.mutateAsync, fileId, updateAnnotation.mutateAsync]);

  const handleTrimAnnotationGap = useCallback(async (
    annotation: RollAnnotation,
    gap: AnnotationGap,
    gapIndex: number
  ) => {
    const action = getGapAction(gap, annotation);
    if (action !== 'trim-start' && action !== 'trim-end') {
      setAnnotationFeedback({
        type: 'error',
        message: 'This gap cannot be trimmed automatically.'
      });
      return;
    }

    const splitKey = `${annotation.id}:${gapIndex}`;
    setSplittingGapKey(splitKey);
    setAnnotationFeedback(null);

    try {
      if (action === 'trim-end') {
        await updateAnnotation.mutateAsync({
          id: annotation.id,
          data: { endTime: gap.startTime }
        });
        setAnnotationFeedback({
          type: 'success',
          message: `Trimmed annotation end to ${formatTime(gap.startTime)}.`
        });
      } else {
        await updateAnnotation.mutateAsync({
          id: annotation.id,
          data: { startTime: gap.endTime }
        });
        setAnnotationFeedback({
          type: 'success',
          message: `Trimmed annotation start to ${formatTime(gap.endTime)}.`
        });
      }
    } catch (error) {
      setAnnotationFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to trim annotation at this gap.'
      });
    } finally {
      setSplittingGapKey((current) => (current === splitKey ? null : current));
    }
  }, [updateAnnotation.mutateAsync]);

  // ---------------------------------------------------------------------------
  // Prediction and completion actions
  // ---------------------------------------------------------------------------

  const handleRunPredictions = useCallback(() => {
    if (file?.isComplete) {
      setPredictionFeedback({
        type: 'error',
        message: 'This file is marked complete. Mark it incomplete to run predictions.'
      });
      return;
    }
    setPredictionFeedback(null);
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
          setPredictionFeedback({ type: 'success', message: `${baseMessage}${clearMessage}` });
        },
        onError: (error) => {
          setPredictionFeedback({
            type: 'error',
            message: error instanceof Error ? error.message : 'Failed to run predictions for this file.'
          });
        }
      }
    );
  }, [file?.isComplete, fileId, runPredictionForFile.mutate]);

  const handleOpenPredictionActionModal = useCallback((predictionId: number) => {
    setPredictionReviewFeedback(null);
    setSelectedPredictionReviewId(predictionId);
  }, []);

  const handleClosePredictionActionModal = useCallback(() => {
    setSelectedPredictionReviewId(null);
  }, []);

  const handleQuickConfirmAndPromote = async () => {
    if (!selectedPredictionReview) return;
    setPredictionReviewFeedback(null);

    try {
      await updatePredictionReview.mutateAsync({
        id: selectedPredictionReview.id,
        data: { status: 'confirmed' }
      });
      await promotePredictionReview.mutateAsync(selectedPredictionReview.id);
      setPredictionReviewFeedback({
        type: 'success',
        message: 'Prediction confirmed and promoted to annotations.'
      });
      setSelectedPredictionReviewId(null);
    } catch (error) {
      setPredictionReviewFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to confirm and promote prediction.'
      });
    }
  };

  const handleQuickMarkInvalid = async () => {
    if (!selectedPredictionReview) return;
    setPredictionReviewFeedback(null);

    try {
      await updatePredictionReview.mutateAsync({
        id: selectedPredictionReview.id,
        data: { status: 'invalid' }
      });
      setPredictionReviewFeedback({ type: 'success', message: 'Prediction marked invalid.' });
      setSelectedPredictionReviewId(null);
    } catch (error) {
      setPredictionReviewFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to mark prediction invalid.'
      });
    }
  };

  const handleToggleFileCompletion = () => {
    if (!file) return;
    setCompletionFeedback(null);
    setPredictionFeedback(null);

    setFileCompletion.mutate(
      { fileId, isComplete: !file.isComplete },
      {
        onSuccess: (result) => {
          if (result.isComplete) {
            const cleared = result.clearedPredictionCount;
            setCompletionFeedback({
              type: 'success',
              message: `File marked complete. Cleared ${cleared} prediction row${cleared === 1 ? '' : 's'} for this file.`
            });
            return;
          }

          setCompletionFeedback({
            type: 'success',
            message: 'File marked incomplete. You can run predictions again for this file.'
          });
        },
        onError: (error) => {
          setCompletionFeedback({
            type: 'error',
            message: error instanceof Error ? error.message : 'Failed to update file completion status.'
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
          <p className="text-red-700">Error loading file: {error instanceof Error ? error.message : 'Unknown error'}</p>
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
  const pendingReviewCount = (reviewListResponse?.reviews ?? []).filter(
    (review) => review.status === 'unsure'
  ).length;
  const pendingReviewBadge = pendingReviewCount > 99 ? '99+' : String(pendingReviewCount);
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
        onSubmitIgnoredSection={handleSubmitIgnoredSection}
        onCancel={handleAnnotationCancel}
        initialSongName={annotationModalData?.initialSongName}
        mode={annotationModalData?.mode ?? 'create'}
        allowTimeEdit={annotationModalData?.mode === 'edit'}
        enableIgnoredSectionOption={annotationModalData?.mode !== 'edit'}
        initialAction={annotationModalData?.initialAction ?? 'annotation'}
      />

      {selectedPredictionReview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={handleClosePredictionActionModal}
        >
          <div
            className="w-full max-w-lg rounded-lg bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b px-5 py-4">
              <h2 className="text-lg font-semibold text-gray-900">Quick Prediction Review</h2>
              <p className="mt-1 text-sm text-gray-600">
                {getPredictionDisplaySongName(selectedPredictionReview)} · {' '}
                {formatTime(getPredictionDisplayStart(selectedPredictionReview))} - {formatTime(getPredictionDisplayEnd(selectedPredictionReview))}
                {selectedPredictionReview.predicted_confidence !== null
                  ? ` · ${Math.round(selectedPredictionReview.predicted_confidence * 100)}% confidence`
                  : ''}
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2 px-5 py-4">
              <button
                onClick={handleClosePredictionActionModal}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                disabled={isPredictionActionPending}
              >
                Cancel
              </button>
              <button
                onClick={() => { void handleQuickMarkInvalid(); }}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:bg-red-300 disabled:cursor-not-allowed"
                disabled={isPredictionActionPending}
              >
                {isPredictionActionPending ? 'Working...' : 'Mark Invalid'}
              </button>
              <button
                onClick={() => { void handleQuickConfirmAndPromote(); }}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:bg-emerald-300 disabled:cursor-not-allowed"
                disabled={isPredictionActionPending}
              >
                {isPredictionActionPending ? 'Working...' : 'Confirm & Promote'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* File Info Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{file.filename}</h1>
        <div className="flex items-center gap-2 mt-1">
          <p className="text-gray-600">Recorded: {file.dateRecorded}</p>
          {file.isComplete && (
            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
              Complete
            </span>
          )}
        </div>
      </div>

      {showError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-red-700 flex-shrink-0" />
          <p className="text-red-700">{showErrorMessage}</p>
        </div>
      )}

      {predictionFeedback && (
        <div
          className={`border rounded-lg p-4 mb-6 ${
            predictionFeedback.type === 'success'
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          <p className="text-sm">{predictionFeedback.message}</p>
          {predictionFeedback.type === 'success' && (
            <button
              onClick={() => { window.location.hash = `/reviews?fileId=${fileId}`; }}
              className="mt-2 text-sm underline font-medium"
            >
              Open review queue for this file
            </button>
          )}
        </div>
      )}

      {predictionReviewFeedback && (
        <div
          className={`border rounded-lg p-4 mb-6 ${
            predictionReviewFeedback.type === 'success'
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          <p className="text-sm">{predictionReviewFeedback.message}</p>
        </div>
      )}

      {completionFeedback && (
        <div
          className={`border rounded-lg p-4 mb-6 ${
            completionFeedback.type === 'success'
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          <p className="text-sm">{completionFeedback.message}</p>
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
            {/* First Row: Title and Main Controls */}
            <div className="flex justify-between items-center mb-3">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <button
                    onClick={handlePlayPause}
                    className="w-10 h-10 rounded-full bg-gray-900 hover:bg-gray-800 text-white flex items-center justify-center transition-all"
                    title={isPlaying ? 'Pause (P)' : 'Play (P)'}
                    aria-label={isPlaying ? 'Pause' : 'Play'}
                  >
                    {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                  </button>

                  <button
                    onClick={stop}
                    className="w-10 h-10 rounded-full bg-gray-200 hover:bg-gray-300 text-gray-700 flex items-center justify-center transition-all"
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
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => setSnapToPlayback(true)}
                  disabled={snapToPlayback}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
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
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                    isAnnotationMode
                      ? 'bg-gray-900 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {isAnnotationMode ? 'Cancel Selection' : 'Select Region'}
                </button>
              </div>
            </div>

            {/* Second Row: Checkpoint Controls */}
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

              <div className="ml-auto text-xs text-gray-500">
                <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-700 font-mono">P</kbd> play/pause · <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-700 font-mono">S</kbd> start · <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-700 font-mono">E</kbd> end · <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-700 font-mono">C</kbd> clear
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
              ignoredSections={ignoredTimelineSegments}
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
              onIgnoredSectionClick={handleIgnoredSectionClick}
              onAnnotationDelete={handleDeleteAnnotation}
              onAnnotationResize={handleAnnotationResize}
            />
            <DetailDeviceMarkers markers={deviceMarkers} onSeek={handleSeek} />
          </div>
        </div>
      )}

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
                : (file.isComplete ? 'Mark Incomplete' : 'Mark Complete')}
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
              onClick={() => { window.location.hash = `/reviews?fileId=${fileId}`; }}
              className="px-4 py-2 bg-gray-100 text-gray-800 rounded-lg hover:bg-gray-200 transition-colors text-sm font-medium inline-flex items-center gap-2"
            >
              Review Predictions
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                {pendingReviewBadge}
              </span>
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
          <p className="mb-4 text-xs text-gray-500">
            Gap pills show internal pauses of {LARGE_ANNOTATION_GAP_SECONDS}s or longer. Click a gap label to jump, then use Split or Trim.
          </p>
          {annotationFeedback && (
            <div
              className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
                annotationFeedback.type === 'success'
                  ? 'border-green-200 bg-green-50 text-green-800'
                  : 'border-red-200 bg-red-50 text-red-800'
              }`}
            >
              {annotationFeedback.message}
            </div>
          )}
          {ignoredSectionFeedback && (
            <div
              className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
                ignoredSectionFeedback.type === 'success'
                  ? 'border-green-200 bg-green-50 text-green-800'
                  : 'border-red-200 bg-red-50 text-red-800'
              }`}
            >
              {ignoredSectionFeedback.message}
            </div>
          )}

          <DetailAnnotationList
            annotations={annotations}
            gapsById={annotationGapsById}
            splittingGapKey={splittingGapKey}
            onSeek={handleSeek}
            onEdit={handleEditAnnotation}
            onDelete={handleDeleteAnnotation}
            onSplitGap={handleSplitAnnotationGap}
            onTrimGap={handleTrimAnnotationGap}
          />

          <div className="mt-8 border-t pt-6">
            <h3 className="text-lg font-semibold text-gray-900">
              Ignored Sections ({ignoredSections.length})
            </h3>
            <p className="mt-1 text-sm text-gray-600">
              Ignored sections are excluded from prediction generation and can be left unannotated.
            </p>

            <DetailIgnoredSections
              sections={ignoredSections}
              isDeleting={deleteIgnoredSection.isPending}
              onSeek={handleSeek}
              onDelete={handleDeleteIgnoredSection}
            />
          </div>
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
    </div>
  );
}
