import { useEffect, useRef, useState } from 'react';
import { Scissors, Sparkles } from 'lucide-react';
import { formatTime } from '@/utils/format'
import { useSongSuggestions } from '@/hooks/useAnnotations'

interface AnnotationModalProps {
  isOpen: boolean;
  startTime: number;
  endTime: number;
  existingSongNames: string[];
  onSubmit: (songName: string, startTime?: number, endTime?: number) => void;
  onCancel: () => void;
  initialSongName?: string;
  mode?: 'create' | 'edit';
  allowTimeEdit?: boolean;
  /** File id used to fetch model-ranked song suggestions in create mode. */
  fileId?: number | null;
  /** Optional callback to snap start/end to nearest played notes. */
  onSnapTimes?: (start: number, end: number) => { startTime: number; endTime: number };
  /** Existing annotation containing the selected region that can be split into two segments. */
  splitTargetAnnotation?: {
    id: number;
    song_name: string;
    start_time: number;
    end_time: number;
  } | null;
  /** Callback to split the containing annotation around the selected region. */
  onSplitAnnotation?: (
    annotation: { id: number; song_name: string; start_time: number; end_time: number },
    startTime: number,
    endTime: number
  ) => Promise<void> | void;
}

export function AnnotationModal({
  isOpen,
  startTime,
  endTime,
  existingSongNames,
  onSubmit,
  onCancel,
  initialSongName = '',
  mode = 'create',
  allowTimeEdit = false,
  fileId = null,
  onSnapTimes,
  splitTargetAnnotation,
  onSplitAnnotation
}: AnnotationModalProps) {
  const [inputValue, setInputValue] = useState(initialSongName);
  const [editStartTime, setEditStartTime] = useState(startTime);
  const [editEndTime, setEditEndTime] = useState(endTime);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isSplitting, setIsSplitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Suggest songs from the model for this region while the create modal is open.
  const suggestionsQuery = useSongSuggestions(
    fileId,
    isOpen && mode === 'create' && !allowTimeEdit ? startTime : null,
    isOpen && mode === 'create' && !allowTimeEdit ? endTime : null
  );
  const songSuggestions = suggestionsQuery.data?.suggestions ?? [];

  // Filter suggestions based on the current input.
  const suggestions = inputValue.trim()
    ? existingSongNames.filter(name =>
        name.toLowerCase().includes(inputValue.toLowerCase())
      )
    : existingSongNames;

  // Reset state when the modal opens.
  useEffect(() => {
    if (isOpen) {
      setInputValue(initialSongName);
      setEditStartTime(startTime);
      setEditEndTime(endTime);
      setSelectedIndex(0);
      setIsSplitting(false);
      // Focus the input once the modal has rendered.
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [isOpen, initialSongName, startTime, endTime]);

  // Reset the selected index when suggestions change.
  useEffect(() => {
    setSelectedIndex(0);
  }, [inputValue]);

  const effectiveStartTime = allowTimeEdit ? editStartTime : startTime;
  const effectiveEndTime = allowTimeEdit ? editEndTime : endTime;
  const canSplitTarget = Boolean(
    splitTargetAnnotation &&
    onSplitAnnotation &&
    splitTargetAnnotation.start_time < effectiveStartTime &&
    effectiveEndTime < splitTargetAnnotation.end_time &&
    effectiveStartTime < effectiveEndTime
  );

  const handleSplit = async () => {
    if (!splitTargetAnnotation || !onSplitAnnotation || !canSplitTarget) return;
    setIsSplitting(true);
    try {
      await onSplitAnnotation(
        splitTargetAnnotation,
        effectiveStartTime,
        effectiveEndTime
      );
    } catch {
      // Caller handles error notification
    } finally {
      setIsSplitting(false);
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const songName = inputValue.trim();
    if (songName) {
      if (allowTimeEdit || editStartTime !== startTime || editEndTime !== endTime) {
        onSubmit(songName, editStartTime, editEndTime);
      } else {
        onSubmit(songName);
      }
    }
  };

  const handleSelectSuggestion = (songName: string) => {
    setInputValue(songName);
    // Submit immediately when selecting from autocomplete (only when not editing times).
    if (!allowTimeEdit) {
      if (editStartTime !== startTime || editEndTime !== endTime) {
        onSubmit(songName, editStartTime, editEndTime);
      } else {
        onSubmit(songName);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestions.length > 0 && selectedIndex < suggestions.length) {
        handleSelectSuggestion(suggestions[selectedIndex]);
      } else {
        handleSubmit();
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-2">
            {mode === 'edit' ? 'Edit Annotation' : 'Create Annotation'}
          </h2>

          {!allowTimeEdit && (
            <div className="flex items-center justify-between text-xs text-gray-500 mb-4">
              <span>
                Region: <strong className="font-semibold text-gray-800">{formatTime(effectiveStartTime)} – {formatTime(effectiveEndTime)}</strong> ({(effectiveEndTime - effectiveStartTime).toFixed(1)}s)
              </span>
              {onSnapTimes && (
                <button
                  type="button"
                  onClick={() => {
                    const snapped = onSnapTimes(editStartTime, editEndTime);
                    setEditStartTime(snapped.startTime);
                    setEditEndTime(snapped.endTime);
                  }}
                  className="text-xs text-indigo-600 hover:text-indigo-800 font-medium inline-flex items-center gap-1 hover:underline cursor-pointer"
                  title="Snap to nearest played notes"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Snap to Notes
                </button>
              )}
            </div>
          )}

          {canSplitTarget && splitTargetAnnotation && (
            <div className="mb-4 p-3.5 rounded-lg border border-amber-200 bg-amber-50/80">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 uppercase tracking-wide">
                    <Scissors className="w-3.5 h-3.5" />
                    Inside Existing Annotation
                  </div>
                  <p className="mt-1 text-sm font-bold text-gray-900 truncate">
                    {splitTargetAnnotation.song_name}
                  </p>
                  <p className="text-xs text-gray-600 mt-0.5">
                    Current span: {formatTime(splitTargetAnnotation.start_time)} – {formatTime(splitTargetAnnotation.end_time)}
                  </p>
                  <p className="mt-1.5 text-xs text-amber-900 leading-relaxed">
                    Split into two segments ({formatTime(splitTargetAnnotation.start_time)} – {formatTime(effectiveStartTime)} and {formatTime(effectiveEndTime)} – {formatTime(splitTargetAnnotation.end_time)}) with a {formatTime(effectiveStartTime)} – {formatTime(effectiveEndTime)} hole.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleSplit}
                  disabled={isSplitting}
                  className="shrink-0 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 active:bg-amber-800 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                  title="Split annotation into two segments with this hole"
                >
                  <Scissors className="w-3.5 h-3.5" />
                  {isSplitting ? 'Splitting...' : 'Split Annotation'}
                </button>
              </div>
            </div>
          )}

          {canSplitTarget && splitTargetAnnotation && (
            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-white px-2 text-gray-400 font-medium">
                  or annotate this region as a song
                </span>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit}>
            {allowTimeEdit && (
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Start Time (seconds)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={editStartTime}
                    onChange={e => setEditStartTime(parseFloat(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#9198E5] focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    End Time (seconds)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={editEndTime}
                    onChange={e => setEditEndTime(parseFloat(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#9198E5] focus:border-transparent"
                  />
                </div>
                <div className="col-span-2 flex items-center justify-between">
                  <p className="text-sm text-gray-600">
                    Region: {formatTime(editStartTime)} - {formatTime(editEndTime)} ({(editEndTime - editStartTime).toFixed(1)}s)
                  </p>
                  {onSnapTimes && (
                    <button
                      type="button"
                      onClick={() => {
                        const snapped = onSnapTimes(editStartTime, editEndTime);
                        setEditStartTime(snapped.startTime);
                        setEditEndTime(snapped.endTime);
                      }}
                      className="text-xs text-indigo-600 hover:text-indigo-800 font-medium inline-flex items-center gap-1 hover:underline cursor-pointer"
                      title="Snap to nearest played notes"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      Snap to Notes
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="mb-4">
              {suggestionsQuery.isFetching && (
                <div className="mb-4 flex items-center gap-2 text-xs text-gray-500">
                  <span className="inline-block h-3 w-3 rounded-full border-2 border-gray-300 border-t-[#9198E5] animate-spin" />
                  Analyzing segment...
                </div>
              )}

              {songSuggestions.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1">
                    <Sparkles className="w-3 h-3" />
                    Suggested songs
                  </p>
                  <div className="space-y-1">
                    {songSuggestions.map((suggestion) => (
                      <button
                        key={suggestion.songName}
                        type="button"
                        onClick={() => handleSelectSuggestion(suggestion.songName)}
                        className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 hover:bg-[#9198E5]/10 hover:border-[#9198E5]/50 transition-colors text-left"
                        title={`Select ${suggestion.songName}`}
                      >
                        <span className="text-sm font-medium text-gray-900 truncate">
                          {suggestion.songName}
                        </span>
                        <span className="text-xs text-gray-500 shrink-0">
                          {Math.round(suggestion.confidence * 100)}%
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <label className="block text-sm font-medium text-gray-700 mb-2">
                Song Name
              </label>
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type to search or enter new song name..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#9198E5] focus:border-transparent"
              />

              {/* Autocomplete suggestions */}
              {suggestions.length > 0 && inputValue.trim() !== '' && (
                <div className="mt-2 border border-gray-200 rounded-lg max-h-48 overflow-y-auto bg-white shadow-lg">
                  {suggestions.map((suggestion, index) => (
                    <div
                      key={suggestion}
                      className={`px-3 py-2 cursor-pointer transition-colors ${
                        index === selectedIndex
                          ? 'bg-gray-900 text-white'
                          : 'hover:bg-gray-100'
                      }`}
                      onClick={() => handleSelectSuggestion(suggestion)}
                    >
                      {suggestion}
                    </div>
                  ))}
                </div>
              )}

              {/* Show all songs hint when input is empty */}
              {inputValue.trim() === '' && existingSongNames.length > 0 && (
                <p className="mt-2 text-xs text-gray-500">
                  {existingSongNames.length} existing song{existingSongNames.length !== 1 ? 's' : ''} available - start typing to filter
                </p>
              )}
            </div>

            <div className="flex gap-3 justify-between items-center">
              {canSplitTarget && splitTargetAnnotation ? (
                <button
                  type="button"
                  onClick={handleSplit}
                  disabled={isSplitting}
                  className="px-3.5 py-2 text-xs font-semibold text-amber-800 hover:text-amber-900 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                >
                  <Scissors className="w-3.5 h-3.5" />
                  {isSplitting ? 'Splitting...' : 'Split Annotation'}
                </button>
              ) : <div />}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={isSplitting}
                  className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!inputValue.trim() || isSplitting}
                  className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {mode === 'edit' ? 'Save Changes' : 'Create Annotation'}
                </button>
              </div>
            </div>
          </form>

          <p className="mt-4 text-xs text-gray-500 text-center">
            Tip: Use ↑↓ to navigate, Enter to select, Esc to cancel
          </p>
        </div>
      </div>
    </div>
  );
}
