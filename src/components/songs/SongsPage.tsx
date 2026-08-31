import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowDown, ArrowUp, Pause, Play, RefreshCw, Square, X } from 'lucide-react';
import { useRenameSongName, useSongPlayHistory, useUniqueSongNames } from '@/hooks/useAnnotations';
import { useSegmentPlayer, toSegmentBounds } from '@/hooks/useSegmentPlayer';
import { useRebuildPredictionModel } from '@/hooks/usePredictionReviews';
import { localFilesApi } from '@/api/localEndpoints';
import type { SongPlayHistoryRow } from '@/api/localTypes';
import { formatTime, formatDate } from '@/utils/format'

export function SongsPage() {
  const { data, isLoading, error, refetch, isFetching } = useSongPlayHistory();
  const { data: uniqueSongNames = [] } = useUniqueSongNames();
  const renameSongName = useRenameSongName();
  const rebuildModel = useRebuildPredictionModel();
  const [loadedFileId, setLoadedFileId] = useState<number | null>(null);
  const [activeSong, setActiveSong] = useState<SongPlayHistoryRow | null>(null);
  const [preparingPlaybackId, setPreparingPlaybackId] = useState<number | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const activeSegmentBounds = useMemo(
    () => (activeSong ? toSegmentBounds(activeSong.start_time, activeSong.end_time) : null),
    [activeSong]
  );
  const {
    loadMidi,
    pause,
    playSegment,
    seekTo,
    stop,
    isLoaded,
    isPlaying,
    segmentCurrentTime,
    segmentElapsed,
    onScrubStart,
    onScrubChange,
    onScrubCommit,
    playbackError: segmentPlaybackError,
    clearPlaybackError
  } = useSegmentPlayer(activeSegmentBounds);

  // Load failures are tracked here; playback failures come from the hook.
  const displayedPlaybackError = playbackError ?? segmentPlaybackError;
  const [showRenamePanel, setShowRenamePanel] = useState(false);
  const [renameFrom, setRenameFrom] = useState('');
  const [renameTo, setRenameTo] = useState('');
  const [renameFeedback, setRenameFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [sortBy, setSortBy] = useState<'song' | 'date'>('date');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const rows = useMemo(() => {
    const raw = [...(data?.songs ?? [])];
    raw.sort((a, b) => {
      if (sortBy === 'song') {
        const cmp = a.song_name.localeCompare(b.song_name, undefined, { sensitivity: 'base' });
        if (cmp !== 0) return sortDirection === 'asc' ? cmp : -cmp;
        const dateCmp = a.date_recorded.localeCompare(b.date_recorded);
        return sortDirection === 'asc' ? dateCmp : -dateCmp;
      }

      const cmp = a.date_recorded.localeCompare(b.date_recorded);
      if (cmp !== 0) return sortDirection === 'asc' ? cmp : -cmp;
      const songCmp = a.song_name.localeCompare(b.song_name, undefined, { sensitivity: 'base' });
      return sortDirection === 'asc' ? songCmp : -songCmp;
    });
    return raw;
  }, [data?.songs, sortBy, sortDirection]);

  const handleSort = (column: 'song' | 'date') => {
    if (sortBy === column) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortBy(column);
    setSortDirection(column === 'date' ? 'desc' : 'asc');
  };

  const sortIcon = (column: 'song' | 'date') => {
    if (sortBy !== column) return null;
    return sortDirection === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5" />
      : <ArrowDown className="w-3.5 h-3.5" />;
  };

  const closeModal = () => {
    stop();
    setActiveSong(null);
    clearPlaybackError();
  };

  useEffect(() => {
    if (!activeSong) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSong]);

  useEffect(() => {
    if (renameFrom) return;
    if (uniqueSongNames.length === 0) return;
    setRenameFrom(uniqueSongNames[0]);
  }, [renameFrom, uniqueSongNames]);

  const ensureLoaded = async (row: SongPlayHistoryRow) => {
    if (loadedFileId === row.file_id && isLoaded) return;
    const blob = await localFilesApi.download(row.file_id);
    await loadMidi(blob);
    setLoadedFileId(row.file_id);
  };

  const handlePlayRow = async (row: SongPlayHistoryRow) => {
    setPlaybackError(null);
    setActiveSong(row);
    setPreparingPlaybackId(row.annotation_id);

    try {
      await ensureLoaded(row);
      await seekTo(row.start_time);
      setPreparingPlaybackId(null);
      void playSegment(row.start_time, row.end_time);
    } catch (err) {
      setPlaybackError(err instanceof Error ? err.message : 'Failed to play selected segment');
    } finally {
      setPreparingPlaybackId((current) => (current === row.annotation_id ? null : current));
    }
  };

  const handlePlayInModal = async () => {
    if (!activeSong || !activeSegmentBounds) return;
    setPlaybackError(null);

    try {
      await ensureLoaded(activeSong);
      const startTime = segmentCurrentTime >= activeSegmentBounds.end
        ? activeSegmentBounds.start
        : segmentCurrentTime;
      void playSegment(startTime, activeSegmentBounds.end);
    } catch (err) {
      setPlaybackError(err instanceof Error ? err.message : 'Failed to play selected segment');
    }
  };

  const handleStopInModal = async () => {
    if (!activeSegmentBounds) return;
    stop();
    await seekTo(activeSegmentBounds.start);
  };

  const openRenamePanel = (initialSongName?: string) => {
    const startSong = initialSongName ?? renameFrom ?? uniqueSongNames[0] ?? '';
    setRenameFrom(startSong);
    setRenameTo((current) => (current.length > 0 ? current : startSong));
    setRenameFeedback(null);
    setShowRenamePanel(true);
  };

  const handleRenameSong = async () => {
    const oldSongName = renameFrom.trim();
    const newSongName = renameTo.trim();

    if (!oldSongName || !newSongName) {
      setRenameFeedback({
        type: 'error',
        message: 'Select an existing song and enter a non-empty new name.'
      });
      return;
    }

    if (oldSongName === newSongName) {
      setRenameFeedback({
        type: 'error',
        message: 'New song name must be different from the current name.'
      });
      return;
    }

    setRenameFeedback(null);

    try {
      const renameResult = await renameSongName.mutateAsync({
        oldSongName,
        newSongName
      });

      try {
        const rebuildResult = await rebuildModel.mutateAsync({});
        setRenameFeedback({
          type: 'success',
          message: `Renamed "${oldSongName}" to "${newSongName}" (${renameResult.annotationsUpdated} annotations, ${renameResult.predictionReviewsPredictedUpdated + renameResult.predictionReviewsReviewedUpdated} prediction fields) and rebuilt model (${rebuildResult.filesUsed} files).`
        });
      } catch (error) {
        setRenameFeedback({
          type: 'error',
          message: `Renamed "${oldSongName}" to "${newSongName}", but model rebuild failed: ${error instanceof Error ? error.message : 'unknown error'}.`
        });
      }
    } catch (error) {
      setRenameFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to rename song.'
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Songs</h1>
          <p className="text-gray-600 mt-1">
            All annotated song segments, ordered by most recently played date.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => openRenamePanel()}
            className="px-3 py-2 bg-indigo-700 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Rename Song
          </button>
          <button
            onClick={() => {
              void refetch();
            }}
            className="px-3 py-2 bg-gray-900 hover:bg-gray-800 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {showRenamePanel && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-indigo-900">Rename Song Globally</h2>
            <button
              onClick={() => {
                setShowRenamePanel(false);
              }}
              className="text-xs text-indigo-700 hover:text-indigo-900 underline"
            >
              Close
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="text-xs text-indigo-900 font-medium space-y-1">
              <span>Current Name</span>
              <select
                value={renameFrom}
                onChange={(event) => {
                  const next = event.target.value;
                  setRenameFrom(next);
                  if (!renameTo || renameTo === renameFrom) {
                    setRenameTo(next);
                  }
                }}
                className="w-full px-3 py-2 rounded border border-indigo-200 bg-white text-sm text-gray-900"
              >
                {uniqueSongNames.map((songName) => (
                  <option key={songName} value={songName}>{songName}</option>
                ))}
              </select>
            </label>

            <label className="text-xs text-indigo-900 font-medium space-y-1">
              <span>New Name</span>
              <input
                type="text"
                value={renameTo}
                onChange={(event) => setRenameTo(event.target.value)}
                placeholder="Enter the corrected song name"
                className="w-full px-3 py-2 rounded border border-indigo-200 bg-white text-sm text-gray-900"
              />
            </label>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                void handleRenameSong();
              }}
              disabled={renameSongName.isPending || rebuildModel.isPending || uniqueSongNames.length === 0}
              className="px-3 py-2 bg-indigo-700 hover:bg-indigo-600 disabled:bg-indigo-300 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
            >
              {renameSongName.isPending || rebuildModel.isPending ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : null}
              Rename and Rebuild Model
            </button>
            <span className="text-xs text-indigo-800">
              Updates annotations and prediction reviews, then retrains `data/ml/model.json`.
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-red-700 flex-shrink-0" />
          <p className="text-red-700 text-sm">
            {error instanceof Error ? error.message : 'Failed to load songs'}
          </p>
        </div>
      )}

      {displayedPlaybackError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-red-700 flex-shrink-0" />
          <p className="text-red-700 text-sm">{displayedPlaybackError}</p>
        </div>
      )}

      {renameFeedback && (
        <div className={`${renameFeedback.type === 'success' ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'} border rounded-lg p-4 flex items-center gap-2`}>
          <AlertCircle className={`w-5 h-5 flex-shrink-0 ${renameFeedback.type === 'success' ? 'text-emerald-700' : 'text-red-700'}`} />
          <p className={`text-sm ${renameFeedback.type === 'success' ? 'text-emerald-700' : 'text-red-700'}`}>
            {renameFeedback.message}
          </p>
        </div>
      )}

      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-left text-gray-600">
                <th className="px-4 py-3 font-semibold">
                  <button
                    onClick={() => handleSort('song')}
                    className="inline-flex items-center gap-1 hover:text-gray-900 transition-colors"
                  >
                    Song
                    {sortIcon('song')}
                  </button>
                </th>
                <th className="px-4 py-3 font-semibold">
                  <button
                    onClick={() => handleSort('date')}
                    className="inline-flex items-center gap-1 hover:text-gray-900 transition-colors"
                  >
                    Date Played
                    {sortIcon('date')}
                  </button>
                </th>
                <th className="px-4 py-3 font-semibold">File</th>
                <th className="px-4 py-3 font-semibold">Segment</th>
                <th className="px-4 py-3 font-semibold">Play</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-gray-500" colSpan={5}>
                    No annotated songs yet.
                  </td>
                </tr>
              )}

              {rows.map((row) => {
                const isPreparing = preparingPlaybackId === row.annotation_id;
                const isActive = activeSong?.annotation_id === row.annotation_id;

                return (
                  <tr key={row.annotation_id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{row.song_name}</td>
                    <td className="px-4 py-3 text-gray-700">{formatDate(row.date_recorded)}</td>
                    <td className="px-4 py-3 text-gray-700">{row.filename}</td>
                    <td className="px-4 py-3 text-gray-700">
                      {formatTime(row.start_time)} - {formatTime(row.end_time)}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => {
                          void handlePlayRow(row);
                        }}
                        disabled={isPreparing}
                        className="px-3 py-1.5 rounded-lg bg-gray-900 hover:bg-gray-800 disabled:bg-gray-500 text-white text-xs font-medium flex items-center gap-1.5 transition-colors"
                      >
                        {isPreparing ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Play className="w-3.5 h-3.5" />
                        )}
                        {isPreparing ? 'Loading' : isActive ? 'Open' : 'Play'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {activeSong && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={closeModal}
        >
          <div
            className="w-full max-w-2xl bg-white rounded-xl border shadow-xl p-5 space-y-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold text-gray-900">{activeSong.song_name}</h2>
                <p className="text-sm text-gray-600 mt-1">
                  {formatDate(activeSong.date_recorded)} · {activeSong.filename}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  Segment: {formatTime(activeSong.start_time)} - {formatTime(activeSong.end_time)}
                </p>
              </div>
              <button
                onClick={closeModal}
                className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {displayedPlaybackError && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-red-700 text-sm">{displayedPlaybackError}</p>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-gray-600">
                <span>{formatTime(segmentElapsed)} / {formatTime(activeSegmentBounds?.duration ?? 0)}</span>
                <span>{formatTime(segmentCurrentTime)}</span>
              </div>
              <input
                type="range"
                min={activeSegmentBounds?.start ?? 0}
                max={activeSegmentBounds?.end ?? 1}
                step={0.01}
                value={segmentCurrentTime}
                disabled={!isLoaded || !!preparingPlaybackId || !activeSegmentBounds}
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
                <span>{formatTime(activeSegmentBounds?.end ?? 0)}</span>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {!isPlaying ? (
                <button
                  onClick={() => {
                    void handlePlayInModal();
                  }}
                  disabled={!isLoaded || !!preparingPlaybackId}
                  className="px-4 py-2 rounded-lg bg-gray-900 hover:bg-gray-800 disabled:bg-gray-400 text-white text-sm font-medium flex items-center gap-2 transition-colors"
                >
                  <Play className="w-4 h-4" />
                  Play
                </button>
              ) : (
                <button
                  onClick={pause}
                  className="px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium flex items-center gap-2 transition-colors"
                >
                  <Pause className="w-4 h-4" />
                  Pause
                </button>
              )}

              <button
                onClick={() => {
                  void handleStopInModal();
                }}
                className="px-4 py-2 rounded-lg bg-gray-200 hover:bg-gray-300 text-gray-800 text-sm font-medium flex items-center gap-2 transition-colors"
              >
                <Square className="w-4 h-4" />
                Stop
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
