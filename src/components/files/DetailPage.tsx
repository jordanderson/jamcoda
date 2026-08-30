import { useEffect, useMemo, useState } from 'react';
import { Play, Pause, Square, Plus, Pencil, Trash2, AlertCircle, Navigation, Flag, Sparkles, X } from 'lucide-react';
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
import { AnnotationModal } from '@/components/annotations/AnnotationModal';
import type { PredictionReview } from '@/api/localTypes';

interface DetailPageProps {
  fileId: number;
}

const LARGE_ANNOTATION_GAP_SECONDS = 6;
const GAP_EDGE_EPSILON = 0.001;

interface GapNote {
  startTime?: number | null;
  endTime?: number | null;
}

interface AnnotationGap {
  startTime: number;
  endTime: number;
  durationSec: number;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getPredictionDisplaySongName(review: PredictionReview): string {
  if (review.status === 'edited' && review.reviewed_song_name) {
    return review.reviewed_song_name;
  }
  return review.predicted_song_name;
}

function getPredictionDisplayStart(review: PredictionReview): number {
  if (review.status === 'edited' && review.reviewed_start_time !== null) {
    return review.reviewed_start_time;
  }
  return review.predicted_start_time;
}

function getPredictionDisplayEnd(review: PredictionReview): number {
  if (review.status === 'edited' && review.reviewed_end_time !== null) {
    return review.reviewed_end_time;
  }
  return review.predicted_end_time;
}

function getLargeAnnotationGaps(
  start: number,
  end: number,
  notes: GapNote[],
  minGapSec: number
): AnnotationGap[] {
  if (!(end > start)) return [];

  const overlaps: Array<{ start: number; end: number }> = [];
  for (const note of notes) {
    const noteStart = note.startTime ?? 0;
    const noteEnd = note.endTime ?? noteStart;
    if (noteEnd <= start || noteStart >= end) {
      continue;
    }
    overlaps.push({
      start: Math.max(start, noteStart),
      end: Math.min(end, noteEnd)
    });
  }

  if (overlaps.length === 0) {
    const fullGap = end - start;
    return fullGap >= minGapSec
      ? [{ startTime: start, endTime: end, durationSec: fullGap }]
      : [];
  }

  overlaps.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [overlaps[0]];

  for (let i = 1; i < overlaps.length; i++) {
    const current = overlaps[i];
    const last = merged[merged.length - 1];
    if (current.start > last.end) {
      merged.push(current);
      continue;
    }
    if (current.end > last.end) {
      last.end = current.end;
    }
  }

  const gaps: AnnotationGap[] = [];
  const addGapIfLarge = (gapStart: number, gapEnd: number) => {
    const durationSec = gapEnd - gapStart;
    if (durationSec >= minGapSec) {
      gaps.push({
        startTime: gapStart,
        endTime: gapEnd,
        durationSec
      });
    }
  };

  addGapIfLarge(start, merged[0].start);
  for (let i = 1; i < merged.length; i++) {
    addGapIfLarge(merged[i - 1].end, merged[i].start);
  }
  addGapIfLarge(merged[merged.length - 1].end, end);

  return gaps;
}

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
  const [annotationModalData, setAnnotationModalData] = useState<{
    startTime: number;
    endTime: number;
    annotationId?: number;
    initialSongName?: string;
    mode?: 'create' | 'edit';
    initialAction?: 'annotation' | 'ignored';
  } | null>(null);
  const [snapToPlayback, setSnapToPlayback] = useState(true);
  const [predictionFeedback, setPredictionFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [completionFeedback, setCompletionFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [predictionReviewFeedback, setPredictionReviewFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [selectedPredictionReviewId, setSelectedPredictionReviewId] = useState<number | null>(null);
  const [hoveredRollTime, setHoveredRollTime] = useState<number | null>(null);
  const [annotationFeedback, setAnnotationFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [ignoredSectionFeedback, setIgnoredSectionFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [splittingGapKey, setSplittingGapKey] = useState<string | null>(null);
  const [loadedFileId, setLoadedFileId] = useState<number | null>(null);
  const annotationGapsById = useMemo(() => {
    const gapMap = new Map<number, AnnotationGap[]>();
    if (!file?.annotations || !sequence?.notes) {
      return gapMap;
    }

    for (const annotation of file.annotations) {
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
  }, [file?.annotations, sequence?.notes]);
  const ignoredSections = useMemo(() => {
    return [...(file?.ignoredSections ?? [])]
      .filter((section) => section.end_time > section.start_time)
      .sort((a, b) => a.start_time - b.start_time || a.id - b.id);
  }, [file?.ignoredSections]);
  const selectedPredictionReview = useMemo(() => {
    if (selectedPredictionReviewId === null) return null;
    return (reviewListResponse?.reviews ?? []).find(
      (review) => review.id === selectedPredictionReviewId
    ) ?? null;
  }, [reviewListResponse?.reviews, selectedPredictionReviewId]);

  useEffect(() => {
    if (selectedPredictionReviewId !== null && !selectedPredictionReview) {
      setSelectedPredictionReviewId(null);
    }
  }, [selectedPredictionReviewId, selectedPredictionReview]);

  // Load MIDI into player when download completes
  useEffect(() => {
    if (!midiBlob) return;
    if (loadedFileId === fileId && isLoaded) return;

    loadMidi(midiBlob)
      .then(() => {
        setLoadedFileId(fileId);
      })
      .catch(err => {
        console.error('Failed to load MIDI into player:', err);
      });
  }, [midiBlob, isLoaded, loadMidi, loadedFileId, fileId]);

  // Jump to annotation if specified in URL
  useEffect(() => {
    if (!isLoaded) return;

    // Parse URL for time parameter
    const hash = window.location.hash;
    const queryStart = hash.indexOf('?');
    if (queryStart === -1) return;

    const queryString = hash.substring(queryStart + 1);
    const params = new URLSearchParams(queryString);
    const timeParam = params.get('time');

    if (timeParam !== null) {
      const startTime = parseFloat(timeParam);
      if (!isNaN(startTime)) {
        // Small delay to ensure player is ready
        setTimeout(() => {
          handleSeek(startTime);
        }, 100);
      }
    }
  }, [isLoaded]);

  // Keyboard shortcuts for checkpoints
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Only if not in an input field
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 's' || e.key === 'S') {
        handleMarkStart();
      } else if (e.key === 'e' || e.key === 'E') {
        handleMarkEnd();
      } else if (e.key === 'c' || e.key === 'C') {
        if (startCheckpoint !== null || endCheckpoint !== null) {
          handleClearCheckpoints();
        }
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [currentTime, startCheckpoint, endCheckpoint]);

  const handlePlayPause = () => {
    if (isPlaying) {
      pause();
    } else {
      // Enable snap mode when starting playback
      setSnapToPlayback(true);
      play();
    }
  };

  const handleCreateAnnotation = () => {
    const startTimeStr = prompt('Enter start time (seconds):');
    const endTimeStr = prompt('Enter end time (seconds):');

    if (!startTimeStr || !endTimeStr) return;

    const startTime = parseFloat(startTimeStr);
    const endTime = parseFloat(endTimeStr);

    if (isNaN(startTime) || isNaN(endTime) || startTime >= endTime) {
      alert('Invalid time values');
      return;
    }

    // Open modal instead of prompt
    setAnnotationModalData({ startTime, endTime, initialAction: 'annotation' });
  };

  const handleSubmitIgnoredSection = async (
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
  };

  const handleDeleteIgnoredSection = (ignoredSectionId: number) => {
    if (!confirm('Delete this ignored section?')) {
      return;
    }
    setIgnoredSectionFeedback(null);
    deleteIgnoredSection.mutate(
      ignoredSectionId,
      {
        onSuccess: () => {
          setIgnoredSectionFeedback({
            type: 'success',
            message: 'Ignored section deleted.'
          });
        },
        onError: (error) => {
          setIgnoredSectionFeedback({
            type: 'error',
            message: error instanceof Error ? error.message : 'Failed to delete ignored section.'
          });
        }
      }
    );
  };

  const handleDeleteAnnotation = (annotationId: number) => {
    if (confirm('Delete this annotation?')) {
      setAnnotationFeedback(null);
      deleteAnnotation.mutate(annotationId);
    }
  };

  const handleRegionSelect = (startTime: number, endTime: number) => {
    setAnnotationModalData({ startTime, endTime, initialAction: 'annotation' });
    setIsAnnotationMode(false);
  };

  const handleSeek = (time: number) => {
    // Enable snap mode when seeking (from timestamp clicks)
    setSnapToPlayback(true);
    seekTo(time);
  };

  const handleIgnoredSectionClick = (ignoredSectionId: number) => {
    const section = ignoredSections.find((item) => item.id === ignoredSectionId);
    if (!section) return;
    handleSeek((section.start_time + section.end_time) / 2);
  };

  const handleAnnotationResize = async (
    annotationId: number,
    times: { startTime: number; endTime: number }
  ) => {
    setAnnotationFeedback(null);

    if (!Number.isFinite(times.startTime) || !Number.isFinite(times.endTime)) {
      const error = new Error('Resized annotation has invalid time values.');
      setAnnotationFeedback({
        type: 'error',
        message: error.message
      });
      throw error;
    }
    if (times.startTime >= times.endTime) {
      const error = new Error('Annotation start time must be less than end time.');
      setAnnotationFeedback({
        type: 'error',
        message: error.message
      });
      throw error;
    }

    try {
      await updateAnnotation.mutateAsync({
        id: annotationId,
        data: {
          startTime: times.startTime,
          endTime: times.endTime
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to resize annotation.';
      setAnnotationFeedback({
        type: 'error',
        message
      });
      throw error;
    }
  };

  const handleAnnotationSubmit = (songName: string, startTime?: number, endTime?: number) => {
    setAnnotationFeedback(null);
    if (annotationModalData) {
      if (annotationModalData.mode === 'edit' && annotationModalData.annotationId) {
        // Update existing annotation
        updateAnnotation.mutate({
          id: annotationModalData.annotationId,
          data: {
            songName,
            startTime: startTime ?? annotationModalData.startTime,
            endTime: endTime ?? annotationModalData.endTime
          }
        });
      } else {
        // Create new annotation
        createAnnotation.mutate({
          fileId,
          songName,
          startTime: annotationModalData.startTime,
          endTime: annotationModalData.endTime
        });
      }
      setAnnotationModalData(null);
    }
  };

  const handleRunPredictions = () => {
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
          setPredictionFeedback({
            type: 'success',
            message: `${baseMessage}${clearMessage}`
          });
        },
        onError: (error) => {
          setPredictionFeedback({
            type: 'error',
            message: error instanceof Error ? error.message : 'Failed to run predictions for this file.'
          });
        }
      }
    );
  };

  const handleOpenPredictionActionModal = (predictionId: number) => {
    setPredictionReviewFeedback(null);
    setSelectedPredictionReviewId(predictionId);
  };

  const handleClosePredictionActionModal = () => {
    setSelectedPredictionReviewId(null);
  };

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
      setPredictionReviewFeedback({
        type: 'success',
        message: 'Prediction marked invalid.'
      });
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

    const targetIsComplete = !file.isComplete;
    setFileCompletion.mutate(
      {
        fileId,
        isComplete: targetIsComplete
      },
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

  const handleAnnotationCancel = () => {
    setAnnotationModalData(null);
  };

  const handleEditAnnotation = (annotation: any) => {
    setAnnotationFeedback(null);
    setAnnotationModalData({
      startTime: annotation.start_time,
      endTime: annotation.end_time,
      annotationId: annotation.id,
      initialSongName: annotation.song_name,
      mode: 'edit',
      initialAction: 'annotation'
    });
  };

  const handleMarkStart = () => {
    setStartCheckpoint(currentTime);
  };

  const handleSplitAnnotationGap = async (
    annotation: {
      id: number;
      song_name: string;
      start_time: number;
      end_time: number;
    },
    gap: AnnotationGap,
    gapIndex: number
  ) => {
    const canSplit = (
      gap.startTime > annotation.start_time + GAP_EDGE_EPSILON
      && gap.endTime < annotation.end_time - GAP_EDGE_EPSILON
    );
    if (!canSplit) {
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
        data: {
          startTime: originalStart,
          endTime: gap.startTime
        }
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
          data: {
            startTime: originalStart,
            endTime: originalEnd
          }
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
  };

  const handleTrimAnnotationGap = async (
    annotation: {
      id: number;
      start_time: number;
      end_time: number;
    },
    gap: AnnotationGap,
    gapIndex: number
  ) => {
    const canTrimStart = (
      gap.startTime <= annotation.start_time + GAP_EDGE_EPSILON
      && gap.endTime < annotation.end_time - GAP_EDGE_EPSILON
    );
    const canTrimEnd = (
      gap.endTime >= annotation.end_time - GAP_EDGE_EPSILON
      && gap.startTime > annotation.start_time + GAP_EDGE_EPSILON
    );

    if (!canTrimStart && !canTrimEnd) {
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
      if (canTrimEnd) {
        await updateAnnotation.mutateAsync({
          id: annotation.id,
          data: {
            endTime: gap.startTime
          }
        });
        setAnnotationFeedback({
          type: 'success',
          message: `Trimmed annotation end to ${formatTime(gap.startTime)}.`
        });
      } else {
        await updateAnnotation.mutateAsync({
          id: annotation.id,
          data: {
            startTime: gap.endTime
          }
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
  };

  const handleMarkEnd = () => {
    setEndCheckpoint(currentTime);
  };

  const handleClearCheckpoints = () => {
    setStartCheckpoint(null);
    setEndCheckpoint(null);
  };

  useEffect(() => {
    setHoveredRollTime(null);
    setSelectedPredictionReviewId(null);
    setPredictionReviewFeedback(null);
    setIgnoredSectionFeedback(null);
  }, [fileId]);

  // Auto-open modal when both checkpoints are set
  useEffect(() => {
    if (startCheckpoint !== null && endCheckpoint !== null) {
      const start = Math.min(startCheckpoint, endCheckpoint);
      const end = Math.max(startCheckpoint, endCheckpoint);

      setAnnotationModalData({ startTime: start, endTime: end, initialAction: 'annotation' });
      handleClearCheckpoints();
    }
  }, [startCheckpoint, endCheckpoint]);

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

  const loadingMidi = isDownloading || (midiBlob && (!isLoaded || loadedFileId !== fileId));
  const showError = downloadError || playerError;
  const showErrorMessage = showError instanceof Error
    ? showError.message
    : (typeof showError === 'string' ? showError : 'Failed to load MIDI file');
  const pendingReviewCount = (reviewListResponse?.reviews ?? []).filter(
    (review) => review.status === 'unsure' || review.status === 'invalid'
  ).length;
  const pendingReviewBadge = pendingReviewCount > 99 ? '99+' : String(pendingReviewCount);
  const rawTimelineEnd = sequence?.totalTime;
  const timelineEndLimit = (
    typeof rawTimelineEnd === 'number'
    && Number.isFinite(rawTimelineEnd)
    && rawTimelineEnd > 0
  )
    ? rawTimelineEnd
    : undefined;
  const predictionTimelineSegments = (reviewListResponse?.reviews ?? [])
    .filter((review) => review.status !== 'invalid')
    .map((review) => {
      const songName = (
        review.status === 'edited'
        && review.reviewed_song_name
      )
        ? review.reviewed_song_name
        : review.predicted_song_name;

      const startTime = (
        review.status === 'edited'
        && review.reviewed_start_time !== null
      )
        ? review.reviewed_start_time
        : review.predicted_start_time;

      const endTime = (
        review.status === 'edited'
        && review.reviewed_end_time !== null
      )
        ? review.reviewed_end_time
        : review.predicted_end_time;

      if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
        return null;
      }

      const normalizedStart = Math.max(0, startTime);
      const normalizedEnd = timelineEndLimit !== undefined
        ? Math.min(timelineEndLimit, endTime)
        : endTime;

      return {
        id: review.id,
        songName,
        startTime: normalizedStart,
        endTime: normalizedEnd,
        confidence: review.predicted_confidence ?? null
      };
    })
    .filter((segment): segment is {
      id: number;
      songName: string;
      startTime: number;
      endTime: number;
      confidence: number | null;
    } => (
      segment !== null
      && segment.endTime > segment.startTime
    ))
    .sort((a, b) => a.startTime - b.startTime || a.id - b.id);
  const ignoredTimelineSegments = ignoredSections.reduce<Array<{
    id: number;
    startTime: number;
    endTime: number;
    reason?: string;
  }>>((segments, section) => {
    if (!Number.isFinite(section.start_time) || !Number.isFinite(section.end_time)) {
      return segments;
    }

    const normalizedStart = Math.max(0, section.start_time);
    const normalizedEnd = timelineEndLimit !== undefined
      ? Math.min(timelineEndLimit, section.end_time)
      : section.end_time;

    if (normalizedEnd <= normalizedStart) {
      return segments;
    }

    segments.push({
      id: section.id,
      startTime: normalizedStart,
      endTime: normalizedEnd,
      reason: section.reason ?? undefined
    });
    return segments;
  }, []);
  const isPredictionActionPending = (
    updatePredictionReview.isPending
    || promotePredictionReview.isPending
  );

  return (
    <div className="space-y-6">
      {/* Annotation Modal */}
      <AnnotationModal
        isOpen={annotationModalData !== null}
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
                onClick={() => {
                  void handleQuickMarkInvalid();
                }}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:bg-red-300 disabled:cursor-not-allowed"
                disabled={isPredictionActionPending}
              >
                {isPredictionActionPending ? 'Working...' : 'Mark Invalid'}
              </button>
              <button
                onClick={() => {
                  void handleQuickConfirmAndPromote();
                }}
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

      {/* Error State */}
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
              onClick={() => {
                window.location.hash = `/reviews?fileId=${fileId}`;
              }}
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

      {/* Loading State */}
      {loadingMidi && (
        <div className="border rounded-lg overflow-hidden shadow-sm bg-white p-12 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900 mx-auto mb-4"></div>
          <p className="text-gray-600">{isDownloading ? 'Downloading MIDI file...' : 'Loading MIDI player...'}</p>
        </div>
      )}

      {/* Piano Roll Visualization */}
      {!loadingMidi && isLoaded && sequence && loadedFileId === fileId && (
        <div className="border rounded-lg overflow-hidden shadow-sm">
          <div className="bg-white p-4 border-b border-gray-200">
            {/* First Row: Title and Main Controls */}
            <div className="flex justify-between items-center mb-3">
              <div className="flex items-center gap-4">
                <h2 className="text-lg font-bold text-gray-900">Piano Roll</h2>

                {/* Player Controls */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={handlePlayPause}
                    className="w-10 h-10 rounded-full bg-gray-900 hover:bg-gray-800 text-white flex items-center justify-center transition-all"
                    title={isPlaying ? 'Pause' : 'Play'}
                  >
                    {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                  </button>

                  <button
                    onClick={stop}
                    className="w-10 h-10 rounded-full bg-gray-200 hover:bg-gray-300 text-gray-700 flex items-center justify-center transition-all"
                    title="Stop"
                  >
                    <Square className="w-4 h-4" />
                  </button>

                  {/* Time Display */}
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

                  {/* Playing Indicator */}
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
                Keyboard: <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-700 font-mono">S</kbd> start · <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-700 font-mono">E</kbd> end · <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-700 font-mono">C</kbd> clear
              </div>
            </div>
          </div>
          <div className="bg-white p-4">
            <PianoRollVisualizer
              sequence={sequence}
              currentTime={currentTime}
              isPlaying={isPlaying}
              annotations={file.annotations}
              predictions={predictionTimelineSegments}
              ignoredSections={ignoredTimelineSegments}
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
          </div>
        </div>
      )}

      {/* Annotations */}
      <div className="border rounded-lg shadow-sm bg-white">
        <div className="p-6 border-b flex justify-between items-center">
          <h2 className="text-xl font-bold text-gray-900">
            Annotations ({file.annotations?.length || 0})
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
              onClick={() => {
                window.location.hash = `/reviews?fileId=${fileId}`;
              }}
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
          {(!file.annotations || file.annotations.length === 0) && (
            <div className="text-center py-8 text-gray-500">
              <p>No annotations yet</p>
              <p className="text-sm mt-2">Click "Add Annotation" to mark song segments</p>
            </div>
          )}

          {file.annotations && file.annotations.length > 0 && (
            <div className="space-y-3">
              {file.annotations.map((annotation: any) => {
                const annotationGaps = annotationGapsById.get(annotation.id) ?? [];

                return (
                  <div
                    key={annotation.id}
                    className="border rounded-lg p-4 flex justify-between items-start hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex-1">
                      <div className="font-semibold text-gray-900">{annotation.song_name}</div>
                      <div className="text-sm text-gray-600 mt-1 flex items-center gap-3">
                        <span className="flex items-center gap-1">
                          <button
                            onClick={() => handleSeek(annotation.start_time)}
                            className="text-gray-700 hover:text-gray-900 font-medium transition-colors cursor-pointer underline"
                            title="Jump to start"
                          >
                            {formatTime(annotation.start_time)}
                          </button>
                          <span className="text-gray-400">→</span>
                          <button
                            onClick={() => handleSeek(annotation.end_time)}
                            className="text-gray-700 hover:text-gray-900 font-medium transition-colors cursor-pointer underline"
                            title="Jump to end"
                          >
                            {formatTime(annotation.end_time)}
                          </button>
                        </span>
                        <span className="text-gray-400">•</span>
                        <span>{formatTime(annotation.end_time - annotation.start_time)}</span>
                      </div>

                      {annotationGaps.length > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {annotationGaps.map((gap, index) => {
                            const midpoint = (gap.startTime + gap.endTime) / 2;
                            const canTrimStart = (
                              gap.startTime <= annotation.start_time + GAP_EDGE_EPSILON
                              && gap.endTime < annotation.end_time - GAP_EDGE_EPSILON
                            );
                            const canTrimEnd = (
                              gap.endTime >= annotation.end_time - GAP_EDGE_EPSILON
                              && gap.startTime > annotation.start_time + GAP_EDGE_EPSILON
                            );
                            const canSplit = (
                              gap.startTime > annotation.start_time + GAP_EDGE_EPSILON
                              && gap.endTime < annotation.end_time - GAP_EDGE_EPSILON
                            );
                            const actionLabel = canSplit
                              ? 'Split'
                              : canTrimEnd
                                ? 'Trim End'
                                : canTrimStart
                                  ? 'Trim Start'
                                  : 'N/A';
                            const gapKey = `${annotation.id}:${index}`;
                            const isSplitting = splittingGapKey === gapKey;
                            return (
                              <div
                                key={`${annotation.id}-gap-${index}`}
                                className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-1"
                              >
                                <button
                                  onClick={() => handleSeek(midpoint)}
                                  className="text-xs font-semibold text-amber-900 hover:text-amber-950 underline-offset-2 hover:underline"
                                  title={`Jump to gap ${formatTime(gap.startTime)} - ${formatTime(gap.endTime)}`}
                                >
                                  Gap {index + 1}: {formatTime(gap.startTime)} - {formatTime(gap.endTime)} ({gap.durationSec.toFixed(1)}s)
                                </button>
                                <button
                                  onClick={() => {
                                    if (canSplit) {
                                      void handleSplitAnnotationGap(annotation, gap, index);
                                      return;
                                    }
                                    void handleTrimAnnotationGap(annotation, gap, index);
                                  }}
                                  disabled={(!canSplit && !canTrimStart && !canTrimEnd) || isSplitting}
                                  className="rounded bg-amber-200 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
                                  title={
                                    canSplit
                                      ? 'Split annotation around this gap'
                                      : canTrimEnd
                                        ? 'Trim annotation end to the start of this gap'
                                        : canTrimStart
                                          ? 'Trim annotation start to the end of this gap'
                                          : 'Cannot split or trim this gap'
                                  }
                                >
                                  {isSplitting ? 'Working...' : actionLabel}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {annotation.notes && (
                        <div className="text-sm text-gray-700 mt-2 italic">{annotation.notes}</div>
                      )}
                    </div>

                    <div className="flex gap-2 ml-4">
                      <button
                        onClick={() => handleEditAnnotation(annotation)}
                        className="text-gray-600 hover:text-gray-900 text-sm font-medium flex items-center gap-1"
                        title="Edit annotation"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteAnnotation(annotation.id)}
                        className="text-red-600 hover:text-red-700 text-sm font-medium flex items-center gap-1"
                        title="Delete annotation"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-8 border-t pt-6">
            <h3 className="text-lg font-semibold text-gray-900">
              Ignored Sections ({ignoredSections.length})
            </h3>
            <p className="mt-1 text-sm text-gray-600">
              Ignored sections are excluded from prediction generation and can be left unannotated.
            </p>

            {ignoredSections.length === 0 ? (
              <div className="mt-4 rounded-lg border border-dashed border-gray-300 px-4 py-6 text-sm text-gray-500">
                No ignored sections for this file.
              </div>
            ) : (
              <div className="mt-4 space-y-2">
                {ignoredSections.map((section) => {
                  const midpoint = (section.start_time + section.end_time) / 2;
                  return (
                    <div
                      key={section.id}
                      className="flex items-start justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2"
                    >
                      <div className="flex-1">
                        <div className="text-sm font-medium text-gray-900">
                          {formatTime(section.start_time)} - {formatTime(section.end_time)} ({formatTime(section.end_time - section.start_time)})
                        </div>
                        {section.reason && (
                          <div className="text-sm text-gray-600 mt-0.5">
                            {section.reason}
                          </div>
                        )}
                      </div>
                      <div className="ml-3 flex gap-2">
                        <button
                          onClick={() => handleSeek(midpoint)}
                          className="rounded bg-white px-2 py-1 text-xs font-medium text-gray-700 border border-gray-300 hover:bg-gray-100"
                        >
                          Jump
                        </button>
                        <button
                          onClick={() => handleDeleteIgnoredSection(section.id)}
                          className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-300"
                          disabled={deleteIgnoredSection.isPending}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Back Button */}
      <div>
        <button
          onClick={() => window.location.hash = '/browse'}
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
