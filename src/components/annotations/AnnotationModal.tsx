import { useEffect, useRef, useState } from 'react';

interface AnnotationModalProps {
  isOpen: boolean;
  startTime: number;
  endTime: number;
  existingSongNames: string[];
  onSubmit: (songName: string, startTime?: number, endTime?: number) => void;
  onSubmitIgnoredSection?: (startTime: number, endTime: number, reason?: string) => void;
  onCancel: () => void;
  initialSongName?: string;
  mode?: 'create' | 'edit';
  allowTimeEdit?: boolean;
  enableIgnoredSectionOption?: boolean;
  initialAction?: 'annotation' | 'ignored';
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function AnnotationModal({
  isOpen,
  startTime,
  endTime,
  existingSongNames,
  onSubmit,
  onSubmitIgnoredSection,
  onCancel,
  initialSongName = '',
  mode = 'create',
  allowTimeEdit = false,
  enableIgnoredSectionOption = false,
  initialAction = 'annotation'
}: AnnotationModalProps) {
  const [inputValue, setInputValue] = useState(initialSongName);
  const [ignoredReason, setIgnoredReason] = useState('');
  const [editStartTime, setEditStartTime] = useState(startTime);
  const [editEndTime, setEditEndTime] = useState(endTime);
  const [actionType, setActionType] = useState<'annotation' | 'ignored'>(initialAction);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter suggestions based on input
  const suggestions = inputValue.trim()
    ? existingSongNames.filter(name =>
        name.toLowerCase().includes(inputValue.toLowerCase())
      )
    : existingSongNames;

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setInputValue(initialSongName);
      setIgnoredReason('');
      setEditStartTime(startTime);
      setEditEndTime(endTime);
      setActionType(initialAction);
      setSelectedIndex(0);
      // Focus input after modal renders
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [isOpen, initialSongName, startTime, endTime, initialAction]);

  // Reset selected index when suggestions change
  useEffect(() => {
    setSelectedIndex(0);
  }, [inputValue]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (actionType === 'ignored') {
      if (!onSubmitIgnoredSection) return;
      onSubmitIgnoredSection(
        allowTimeEdit ? editStartTime : startTime,
        allowTimeEdit ? editEndTime : endTime,
        ignoredReason.trim() || undefined
      );
      return;
    }

    const songName = inputValue.trim();
    if (songName) {
      if (allowTimeEdit) {
        onSubmit(songName, editStartTime, editEndTime);
      } else {
        onSubmit(songName);
      }
    }
  };

  const handleSelectSuggestion = (songName: string) => {
    setInputValue(songName);
    // Submit immediately when selecting from autocomplete (only if not editing times)
    if (!allowTimeEdit && actionType === 'annotation') {
      onSubmit(songName);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel();
    } else if (actionType === 'ignored' && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
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
          <h2 className="text-xl font-bold mb-2 text-gray-900">
            {mode === 'edit' ? 'Edit Annotation' : 'Create Annotation'}
          </h2>
          {!allowTimeEdit && (
            <p className="text-sm text-gray-600 mb-4">
              Region: {formatTime(startTime)} - {formatTime(endTime)} ({(endTime - startTime).toFixed(1)}s)
            </p>
          )}

          <form onSubmit={handleSubmit}>
          {allowTimeEdit && (
            <div className="mb-4 grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Start Time (seconds)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={editStartTime}
                    onChange={e => setEditStartTime(parseFloat(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#9198E5] focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    End Time (seconds)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={editEndTime}
                    onChange={e => setEditEndTime(parseFloat(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#9198E5] focus:border-transparent"
                  />
                </div>
                <p className="col-span-2 text-sm text-gray-600">
                  Region: {formatTime(editStartTime)} - {formatTime(editEndTime)} ({(editEndTime - editStartTime).toFixed(1)}s)
                </p>
            </div>
          )}

          {enableIgnoredSectionOption && mode === 'create' && (
            <div className="mb-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setActionType('annotation')}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  actionType === 'annotation'
                    ? 'bg-gray-900 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Create Annotation
              </button>
              <button
                type="button"
                onClick={() => setActionType('ignored')}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  actionType === 'ignored'
                    ? 'bg-red-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Mark Invalid
              </button>
            </div>
          )}

          {actionType === 'annotation' ? (
            <div className="mb-4">
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
          ) : (
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Reason (optional)
              </label>
              <input
                ref={inputRef}
                type="text"
                value={ignoredReason}
                onChange={e => setIgnoredReason(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="e.g. noodling, metronome, talking, artifact"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#9198E5] focus:border-transparent"
              />
            </div>
          )}

            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={onCancel}
                className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={actionType === 'annotation' && !inputValue.trim()}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {actionType === 'ignored'
                  ? 'Mark Invalid'
                  : (mode === 'edit' ? 'Save Changes' : 'Create Annotation')}
              </button>
            </div>
          </form>

          {actionType === 'annotation' && (
            <p className="mt-4 text-xs text-gray-500 text-center">
              Tip: Use ↑↓ to navigate, Enter to select, Esc to cancel
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
