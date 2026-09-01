import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  CircleSlash,
  Edit3,
  ExternalLink,
  Pause,
  Play,
  RefreshCw,
  SkipForward,
  Square,
  Upload
} from 'lucide-react';
import { useFilesByDate } from '@/hooks/useFilesByDate';
import {
  usePredictionReviews,
  useMergePredictionReviews,
  usePromotePredictionReview,
  usePromoteReviewedPredictionReviews,
  useUpdatePredictionReview
} from '@/hooks/usePredictionReviews';
import { useUniqueSongNames } from '@/hooks/useAnnotations';
import { useLocalFileDownload } from '@/hooks/useLocalFileDownload';
import { useSegmentPlayer, toSegmentBounds } from '@/hooks/useSegmentPlayer';
import { resolveReviewFields } from '@core/predictionReview';
import { AnnotationModal } from '@/components/annotations/AnnotationModal';
import type { PredictionReview, PredictionReviewStatus } from '@/api/localTypes';
import { formatTime, formatDate } from '@/utils/format'

type ReviewFilter = 'needs-review' | 'all';

interface EditModalData {
  reviewId: number;
  initialSongName: string;
  startTime: number;
  endTime: number;
}

interface DateGroup {
  date: string;
  files: Array<{
    id: number;
    filename: string;
    unreviewedPredictionCount: number;
  }>;
}

function getStatusBadgeClasses(status: PredictionReviewStatus): string {
  if (status === 'confirmed') return 'bg-green-100 text-green-800';
  if (status === 'edited') return 'bg-blue-100 text-blue-800';
  if (status === 'invalid') return 'bg-red-100 text-red-800';
  return 'bg-gray-100 text-gray-700';
}

function getInitialFileIdFromHash(): number | undefined {
  const hash = window.location.hash;
  const queryStart = hash.indexOf('?');
  if (queryStart === -1) return undefined;

  const queryString = hash.slice(queryStart + 1);
  const params = new URLSearchParams(queryString);
  const fileId = Number(params.get('fileId'));
  if (!Number.isInteger(fileId) || fileId <= 0) {
    return undefined;
  }
  return fileId;
}

function getReviewSortScore(review: PredictionReview): number {
  if (review.status === 'unsure') return 0;
  if (review.status === 'invalid') return 1;
  if (review.status === 'confirmed') return 2;
  return 3;
}

// Thin adapters over the shared resolver so call sites stay readable.
const getDisplaySongName = (review: PredictionReview): string => resolveReviewFields(review).songName
const getDisplayStart = (review: PredictionReview): number => resolveReviewFields(review).startTime
const getDisplayEnd = (review: PredictionReview): number => resolveReviewFields(review).endTime

export function PredictionReviewPage() {
  const [selectedFileId, setSelectedFileId] = useState<number | undefined>(getInitialFileIdFromHash());
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('needs-review');
  const [activeReviewId, setActiveReviewId] = useState<number | null>(null);
  const [selectedReviewIds, setSelectedReviewIds] = useState<number[]>([]);
  const [editModalData, setEditModalData] = useState<EditModalData | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [loadedFileId, setLoadedFileId] = useState<number | null>(null);

  const { data: filesByDate } = useFilesByDate();
  const {
    data: reviewListResponse,
    isLoading: isLoadingReviews,
    error: reviewsError,
    refetch
  } = usePredictionReviews({
    fileId: selectedFileId,
    includePromoted: false,
    limit: 500
  });
  const updateReview = useUpdatePredictionReview();
  const mergeReviews = useMergePredictionReviews();
  const promoteReview = usePromotePredictionReview();
  const promoteReviewed = usePromoteReviewedPredictionReviews();
  const { data: uniqueSongNames = [] } = useUniqueSongNames();

  const fileOptions = useMemo(() => {
    const groups = (filesByDate?.dates ?? []) as DateGroup[];
    const flattened = groups.flatMap((group) =>
      group.files.map((file) => ({
        id: file.id,
        filename: file.filename,
        date: group.date,
        unreviewedPredictionCount: file.unreviewedPredictionCount
      }))
    );

    const withPredictions = flattened.filter((file) => file.unreviewedPredictionCount > 0);
    withPredictions.sort((a, b) => b.date.localeCompare(a.date));
    return withPredictions;
  }, [filesByDate]);

  const filteredReviews = useMemo(() => {
    const reviews = [...(reviewListResponse?.reviews ?? [])];
    reviews.sort((a, b) => {
      const statusDiff = getReviewSortScore(a) - getReviewSortScore(b);
      if (statusDiff !== 0) return statusDiff;
      return b.created_at - a.created_at;
    });

    if (reviewFilter === 'all') return reviews;
    return reviews.filter((review) => review.status === 'unsure');
  }, [reviewListResponse?.reviews, reviewFilter]);

  const selectedReviews = useMemo(() => {
    if (selectedReviewIds.length === 0) return [] as PredictionReview[];
    const byId = new Map(filteredReviews.map((review) => [review.id, review]));
    return selectedReviewIds
      .map((id) => byId.get(id))
      .filter((review): review is PredictionReview => review !== undefined);
  }, [filteredReviews, selectedReviewIds]);

  const mergeSelectionValidation = useMemo(() => {
    if (selectedReviewIds.length < 2) {
      return {
        canMerge: false,
        message: selectedReviewIds.length === 0
          ? 'Select at least 2 consecutive rows to merge.'
          : 'Select one more row to merge.'
      };
    }

    if (selectedReviews.length !== selectedReviewIds.length) {
      return {
        canMerge: false,
        message: 'Selected rows must remain visible in the current filter.'
      };
    }

    const indexMap = new Map(filteredReviews.map((review, index) => [review.id, index]));
    const indices = selectedReviewIds
      .map((id) => indexMap.get(id))
      .filter((index): index is number => index !== undefined)
      .sort((a, b) => a - b);

    for (let i = 1; i < indices.length; i += 1) {
      if (indices[i] !== indices[i - 1] + 1) {
        return {
          canMerge: false,
          message: 'Selected rows must be consecutive in the queue.'
        };
      }
    }

    const fileId = selectedReviews[0].file_id;
    if (!selectedReviews.every((review) => review.file_id === fileId)) {
      return {
        canMerge: false,
        message: 'All selected rows must belong to the same file.'
      };
    }

    const songName = getDisplaySongName(selectedReviews[0]);
    if (!selectedReviews.every((review) => getDisplaySongName(review) === songName)) {
      return {
        canMerge: false,
        message: 'All selected rows must have the same song name.'
      };
    }

    if (!selectedReviews.every((review) => getDisplayEnd(review) > getDisplayStart(review))) {
      return {
        canMerge: false,
        message: 'Selected rows contain an invalid time range.'
      };
    }

    return {
      canMerge: true,
      message: `Merge into one segment from ${formatTime(Math.min(...selectedReviews.map(getDisplayStart)))} to ${formatTime(Math.max(...selectedReviews.map(getDisplayEnd)))}.`
    };
  }, [filteredReviews, selectedReviewIds, selectedReviews]);

  const activeReview = useMemo(
    () => filteredReviews.find((review) => review.id === activeReviewId) ?? null,
    [filteredReviews, activeReviewId]
  );
  const activeSegmentBounds = useMemo(() => {
    if (!activeReview) return null;
    return toSegmentBounds(getDisplayStart(activeReview), getDisplayEnd(activeReview));
  }, [activeReview]);
  const activeFileId = activeReview?.file_id ?? null;
  const {
    data: midiBlob,
    isLoading: isDownloadingMidi,
    error: midiDownloadError
  } = useLocalFileDownload(activeFileId, !!activeFileId);
  const {
    pause,
    stop,
    loadMidi,
    seekTo,
    isPlaying,
    isLoaded,
    error: playerError,
    segmentCurrentTime,
    segmentElapsed,
    onScrubStart,
    onScrubChange,
    onScrubCommit,
    playFromStart,
    restart,
    playbackError: segmentPlaybackError
  } = useSegmentPlayer(activeSegmentBounds);

  // Load/decoding failures surface as `playerError`. Segment transport
  // failures come from the segment hook.
  const playbackError = playerError ?? segmentPlaybackError;

  const isPendingAction = (
    updateReview.isPending
    || mergeReviews.isPending
    || promoteReview.isPending
    || promoteReviewed.isPending
  );

  useEffect(() => {
    if (filteredReviews.length === 0) {
      setActiveReviewId(null);
      return;
    }

    if (!activeReviewId || !filteredReviews.some((review) => review.id === activeReviewId)) {
      setActiveReviewId(filteredReviews[0].id);
    }
  }, [filteredReviews, activeReviewId]);

  useEffect(() => {
    const validIds = new Set(filteredReviews.map((review) => review.id));
    setSelectedReviewIds((previous) => previous.filter((id) => validIds.has(id)));
  }, [filteredReviews]);

  useEffect(() => {
    if (!midiBlob || !activeFileId) return;
    if (loadedFileId === activeFileId && isLoaded) return;

    loadMidi(midiBlob)
      .then(() => {
        setLoadedFileId(activeFileId);
      })
      .catch((error) => {
        console.error('Failed to load review MIDI file:', error);
      });
  }, [midiBlob, activeFileId, loadedFileId, isLoaded, loadMidi]);

  useEffect(() => {
    stop();
    // Intentionally only when the selected review changes.
    // `stop` identity is not stable, and including it here causes playback
    // to stop immediately on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeReviewId]);

  useEffect(() => {
    const handleHashChange = () => {
      const route = window.location.hash.slice(1);
      if (!route.startsWith('/reviews')) return;
      setSelectedFileId(getInitialFileIdFromHash());
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const selectFile = (fileId: number | undefined) => {
    setSelectedFileId(fileId);
    setSelectedReviewIds([]);
    setFeedback(null);
    if (fileId) {
      window.location.hash = `/reviews?fileId=${fileId}`;
    } else {
      window.location.hash = '/reviews';
    }
  };

  const toggleReviewSelection = (reviewId: number, checked: boolean) => {
    setSelectedReviewIds((previous) => {
      if (checked) {
        if (previous.includes(reviewId)) return previous;
        return [...previous, reviewId];
      }
      return previous.filter((id) => id !== reviewId);
    });
  };

  const handleMergeSelected = async () => {
    if (!mergeSelectionValidation.canMerge) {
      setFeedback({
        type: 'error',
        message: mergeSelectionValidation.message ?? 'Selected rows cannot be merged.'
      });
      return;
    }

    setFeedback(null);
    try {
      const result = await mergeReviews.mutateAsync({ reviewIds: selectedReviewIds });
      setReviewFilter('all');
      setActiveReviewId(result.mergedReviewId);
      setSelectedReviewIds([result.mergedReviewId]);
      setFeedback({
        type: 'success',
        message: `Merged ${result.replacedCount} segments into one (${formatTime(result.mergedStartTime)} - ${formatTime(result.mergedEndTime)}).`
      });
    } catch (error) {
      setFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to merge selected segments.'
      });
    }
  };

  const goToNextReview = () => {
    if (!activeReview) return;
    const currentIndex = filteredReviews.findIndex((review) => review.id === activeReview.id);
    if (currentIndex === -1) return;

    const next = filteredReviews[currentIndex + 1];
    if (next) {
      setActiveReviewId(next.id);
      return;
    }

    const previous = filteredReviews[currentIndex - 1];
    if (previous) {
      setActiveReviewId(previous.id);
    }
  };

  const handleConfirmAndPromote = async () => {
    if (!activeReview) return;
    setFeedback(null);

    try {
      await updateReview.mutateAsync({
        id: activeReview.id,
        data: { status: 'confirmed' }
      });

      await promoteReview.mutateAsync(activeReview.id);
      setFeedback({ type: 'success', message: 'Prediction confirmed and promoted to annotations.' });
      goToNextReview();
    } catch (error) {
      setFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to confirm and promote prediction.'
      });
    }
  };

  const handleMarkInvalid = async () => {
    if (!activeReview) return;
    setFeedback(null);

    try {
      await updateReview.mutateAsync({
        id: activeReview.id,
        data: { status: 'invalid' }
      });
      setFeedback({ type: 'success', message: 'Prediction marked as invalid.' });
      goToNextReview();
    } catch (error) {
      setFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to mark prediction invalid.'
      });
    }
  };

  const handleOpenEditModal = () => {
    if (!activeReview) return;
    setFeedback(null);
    setEditModalData({
      reviewId: activeReview.id,
      initialSongName: getDisplaySongName(activeReview),
      startTime: getDisplayStart(activeReview),
      endTime: getDisplayEnd(activeReview)
    });
  };

  const handleEditedPromotion = async (songName: string, startTime?: number, endTime?: number) => {
    if (!editModalData || startTime === undefined || endTime === undefined) return;
    setFeedback(null);

    try {
      await updateReview.mutateAsync({
        id: editModalData.reviewId,
        data: {
          status: 'edited',
          reviewedSongName: songName,
          reviewedStartTime: startTime,
          reviewedEndTime: endTime
        }
      });

      await promoteReview.mutateAsync(editModalData.reviewId);
      setFeedback({ type: 'success', message: 'Edited prediction promoted to annotations.' });
      setEditModalData(null);
      goToNextReview();
    } catch (error) {
      setFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to promote edited prediction.'
      });
    }
  };

  const handlePromoteReviewed = async () => {
    setFeedback(null);
    try {
      const result = await promoteReviewed.mutateAsync({
        fileId: selectedFileId,
        limit: 500
      });

      const promotedCount = result.promoted.length;
      if (result.failed.length > 0) {
        setFeedback({
          type: 'error',
          message: `Promoted ${promotedCount}, but ${result.failed.length} failed.`
        });
        return;
      }

      setFeedback({
        type: 'success',
        message: promotedCount > 0
          ? `Promoted ${promotedCount} reviewed prediction(s).`
          : 'No reviewed predictions were pending promotion.'
      });
    } catch (error) {
      setFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to promote reviewed predictions.'
      });
    }
  };

  const openDetailAtReview = () => {
    if (!activeReview) return;
    const startTime = getDisplayStart(activeReview);
    window.location.hash = `/detail/${activeReview.file_id}?time=${startTime}`;
  };

  const handlePlaySegment = async () => {
    await playFromStart();
  };

  const handlePauseSegment = () => {
    pause();
  };

  const handleStopPlayback = () => {
    stop();
  };

  const handleJumpToStart = async () => {
    await restart();
  };

  const handleJumpToEnd = async () => {
    if (!activeSegmentBounds || !isLoaded) return;
    await seekTo(activeSegmentBounds.end);
  };

  const selectedFileLabel = fileOptions.find((file) => file.id === selectedFileId);
  const showPlaybackError = midiDownloadError || playbackError;

  return (
    <div className="space-y-5">
      <AnnotationModal
        isOpen={editModalData !== null}
        startTime={editModalData?.startTime ?? 0}
        endTime={editModalData?.endTime ?? 0}
        existingSongNames={uniqueSongNames}
        onSubmit={handleEditedPromotion}
        onCancel={() => setEditModalData(null)}
        initialSongName={editModalData?.initialSongName}
        mode="edit"
        allowTimeEdit
      />

      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold text-gray-900">Prediction Review</h1>
        <p className="text-gray-600">
          Review model predictions, fix boundaries if needed, and promote valid ones into annotations.
        </p>
      </div>

      <div className="bg-white border rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">File</label>
            <select
              className="px-3 py-2 border rounded-lg text-sm bg-white min-w-[260px]"
              value={selectedFileId ?? ''}
              onChange={(e) => {
                const value = e.target.value ? Number(e.target.value) : undefined;
                selectFile(value);
              }}
            >
              <option value="">All files</option>
              {fileOptions.map((file) => (
                <option key={file.id} value={file.id}>
                  {formatDate(file.date)} - {file.filename}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">Filter</label>
            <select
              className="px-3 py-2 border rounded-lg text-sm bg-white"
              value={reviewFilter}
              onChange={(e) => setReviewFilter(e.target.value as ReviewFilter)}
            >
              <option value="needs-review">Needs Review</option>
              <option value="all">All Unpromoted</option>
            </select>
          </div>

          <button
            onClick={() => refetch()}
            className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg flex items-center gap-2 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>

          <button
            onClick={handlePromoteReviewed}
            disabled={isPendingAction}
            className="px-3 py-2 text-sm bg-gray-900 hover:bg-gray-800 disabled:bg-gray-600 text-white rounded-lg flex items-center gap-2 transition-colors"
          >
            <Upload className="w-4 h-4" />
            Promote Reviewed
          </button>

          <button
            onClick={() => {
              void handleMergeSelected();
            }}
            disabled={isPendingAction || !mergeSelectionValidation.canMerge}
            className="px-3 py-2 text-sm bg-indigo-700 hover:bg-indigo-600 disabled:bg-indigo-300 text-white rounded-lg flex items-center gap-2 transition-colors"
          >
            Merge Selected ({selectedReviewIds.length})
          </button>

          {selectedReviewIds.length > 0 && (
            <button
              onClick={() => setSelectedReviewIds([])}
              className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              Clear Selection
            </button>
          )}
        </div>

        {selectedFileLabel && (
          <p className="text-xs text-gray-500">
            Viewing file: {formatDate(selectedFileLabel.date)} - {selectedFileLabel.filename}
          </p>
        )}
        <p className="text-xs text-gray-500">
          {mergeSelectionValidation.message}
        </p>
      </div>

      {feedback && (
        <div
          className={`px-4 py-3 rounded-lg border text-sm ${
            feedback.type === 'success'
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          {feedback.message}
        </div>
      )}

      {reviewsError && (
        <div className="px-4 py-3 rounded-lg border bg-red-50 border-red-200 text-red-800 text-sm">
          {reviewsError instanceof Error ? reviewsError.message : 'Failed to load prediction reviews.'}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="bg-white border rounded-lg overflow-hidden lg:col-span-1">
          <div className="px-4 py-3 border-b bg-gray-50">
            <h2 className="font-semibold text-gray-900">
              Queue ({filteredReviews.length})
            </h2>
          </div>

          <div className="max-h-[620px] overflow-y-auto divide-y">
            {isLoadingReviews && (
              <div className="p-5 text-sm text-gray-500">Loading reviews...</div>
            )}

            {!isLoadingReviews && filteredReviews.length === 0 && (
              <div className="p-5 text-sm text-gray-500">
                No reviews found for this filter.
              </div>
            )}

            {filteredReviews.map((review) => {
              const isActive = review.id === activeReviewId;
              const isSelected = selectedReviewIds.includes(review.id);
              return (
                <div
                  key={review.id}
                  className={`px-4 py-3 transition-colors ${
                    isActive ? 'bg-gray-900 text-white' : 'hover:bg-gray-50 text-gray-900'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(event) => {
                        toggleReviewSelection(review.id, event.target.checked);
                      }}
                      className="mt-1 h-4 w-4 rounded border-gray-300 accent-indigo-600"
                      aria-label={`Select review ${review.id} for merge`}
                    />
                    <button
                      onClick={() => setActiveReviewId(review.id)}
                      className="flex-1 text-left"
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <div className="font-medium truncate">{getDisplaySongName(review)}</div>
                        <span
                          className={`text-[11px] px-2 py-0.5 rounded-full ${
                            isActive ? 'bg-white/20 text-white' : getStatusBadgeClasses(review.status)
                          }`}
                        >
                          {review.status}
                        </span>
                      </div>
                      <div className={`text-xs ${isActive ? 'text-gray-200' : 'text-gray-500'}`}>
                        {formatTime(getDisplayStart(review))} - {formatTime(getDisplayEnd(review))}
                      </div>
                      <div className={`text-xs mt-1 ${isActive ? 'text-gray-300' : 'text-gray-500'}`}>
                        file #{review.file_id}
                        {' · '}
                        conf {review.predicted_confidence !== null ? review.predicted_confidence.toFixed(2) : 'n/a'}
                      </div>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-white border rounded-lg p-5 lg:col-span-2">
          {!activeReview && (
            <div className="text-gray-500 text-sm">
              Select a review from the queue to inspect and act on it.
            </div>
          )}

          {activeReview && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`text-xs px-2 py-1 rounded-full ${getStatusBadgeClasses(activeReview.status)}`}>
                  {activeReview.status}
                </span>
                <span className="text-xs text-gray-500">
                  Created {new Date(activeReview.created_at * 1000).toLocaleString()}
                </span>
                {activeReview.model_version && (
                  <span className="text-xs text-gray-500">Model: {activeReview.model_version}</span>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border rounded-lg p-3 bg-gray-50">
                  <h3 className="text-sm font-semibold text-gray-700 mb-2">Prediction</h3>
                  <div className="space-y-1 text-sm text-gray-700">
                    <div>Song: <span className="font-medium">{activeReview.predicted_song_name}</span></div>
                    <div>Start: {formatTime(activeReview.predicted_start_time)} ({activeReview.predicted_start_time.toFixed(2)}s)</div>
                    <div>End: {formatTime(activeReview.predicted_end_time)} ({activeReview.predicted_end_time.toFixed(2)}s)</div>
                    <div>Confidence: {activeReview.predicted_confidence !== null ? activeReview.predicted_confidence.toFixed(3) : 'n/a'}</div>
                  </div>
                </div>

                <div className="border rounded-lg p-3">
                  <h3 className="text-sm font-semibold text-gray-700 mb-2">Reviewed Values</h3>
                  <div className="space-y-1 text-sm text-gray-700">
                    <div>Song: <span className="font-medium">{activeReview.reviewed_song_name ?? '—'}</span></div>
                    <div>
                      Start:{' '}
                      {activeReview.reviewed_start_time !== null
                        ? `${formatTime(activeReview.reviewed_start_time)} (${activeReview.reviewed_start_time.toFixed(2)}s)`
                        : '—'}
                    </div>
                    <div>
                      End:{' '}
                      {activeReview.reviewed_end_time !== null
                        ? `${formatTime(activeReview.reviewed_end_time)} (${activeReview.reviewed_end_time.toFixed(2)}s)`
                        : '—'}
                    </div>
                    <div>Notes: {activeReview.review_notes ?? '—'}</div>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  onClick={handleConfirmAndPromote}
                  disabled={isPendingAction}
                  className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-300 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
                >
                  <Check className="w-4 h-4" />
                  Confirm & Promote
                </button>

                <button
                  onClick={handleOpenEditModal}
                  disabled={isPendingAction}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
                >
                  <Edit3 className="w-4 h-4" />
                  Edit & Promote
                </button>

                <button
                  onClick={handleMarkInvalid}
                  disabled={isPendingAction}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
                >
                  <CircleSlash className="w-4 h-4" />
                  Mark Invalid
                </button>

                <button
                  onClick={goToNextReview}
                  className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
                >
                  <SkipForward className="w-4 h-4" />
                  Skip
                </button>

                <button
                  onClick={openDetailAtReview}
                  className="px-4 py-2 bg-gray-900 hover:bg-gray-800 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                  Open In Detail View
                </button>
              </div>

              <div className="border rounded-lg p-4 bg-gray-50 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-gray-800">Segment Playback</h3>
                  <div className="text-xs text-gray-600">
                    {formatTime(segmentElapsed)} / {formatTime(activeSegmentBounds?.duration ?? 0)}
                  </div>
                </div>

                {showPlaybackError && (
                  <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                    {showPlaybackError instanceof Error ? showPlaybackError.message : 'Failed to load MIDI for playback.'}
                  </div>
                )}

                <div className="space-y-2">
                  <div className="text-xs text-gray-600">
                    Segment: {formatTime(getDisplayStart(activeReview))} - {formatTime(getDisplayEnd(activeReview))}
                  </div>
                  <input
                    type="range"
                    min={activeSegmentBounds?.start ?? 0}
                    max={activeSegmentBounds?.end ?? 1}
                    step={0.01}
                    value={segmentCurrentTime}
                    disabled={!isLoaded || isDownloadingMidi || !activeSegmentBounds}
                    onChange={(event) => onScrubChange(Number(event.target.value))}
                    onMouseDown={onScrubStart}
                    onTouchStart={onScrubStart}
                    onMouseUp={onScrubCommit}
                    onTouchEnd={onScrubCommit}
                    onKeyUp={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        onScrubCommit();
                      }
                    }}
                    className="w-full accent-gray-900"
                  />
                  <div className="flex items-center justify-between text-[11px] text-gray-500">
                    <span>{formatTime(activeSegmentBounds?.start ?? 0)}</span>
                    <span>{formatTime(segmentCurrentTime)}</span>
                    <span>{formatTime(activeSegmentBounds?.end ?? 0)}</span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {!isPlaying ? (
                    <button
                      onClick={handlePlaySegment}
                      disabled={!isLoaded || isDownloadingMidi}
                      className="px-3 py-2 rounded-lg bg-gray-900 hover:bg-gray-800 disabled:bg-gray-400 text-white text-sm font-medium flex items-center gap-2 transition-colors"
                    >
                      <Play className="w-4 h-4" />
                      Play Segment
                    </button>
                  ) : (
                    <button
                      onClick={handlePauseSegment}
                      className="px-3 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium flex items-center gap-2 transition-colors"
                    >
                      <Pause className="w-4 h-4" />
                      Pause
                    </button>
                  )}

                  <button
                    onClick={handleStopPlayback}
                    className="px-3 py-2 rounded-lg bg-gray-200 hover:bg-gray-300 text-gray-800 text-sm font-medium flex items-center gap-2 transition-colors"
                  >
                    <Square className="w-4 h-4" />
                    Stop
                  </button>

                  <button
                    onClick={handleJumpToStart}
                    disabled={!isLoaded || isDownloadingMidi}
                    className="px-3 py-2 rounded-lg bg-white hover:bg-gray-100 disabled:bg-gray-100 disabled:text-gray-400 border text-gray-700 text-sm font-medium transition-colors"
                  >
                    Jump Start
                  </button>

                  <button
                    onClick={handleJumpToEnd}
                    disabled={!isLoaded || isDownloadingMidi}
                    className="px-3 py-2 rounded-lg bg-white hover:bg-gray-100 disabled:bg-gray-100 disabled:text-gray-400 border text-gray-700 text-sm font-medium transition-colors"
                  >
                    Jump End
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
