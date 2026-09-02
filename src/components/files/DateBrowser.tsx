import { useFilesByDate } from '@/hooks/useFilesByDate';
import { ArrowDown, ChevronRight } from 'lucide-react';
import type { FileByDateRow } from '@/api/localTypes';
import { formatDate, formatDuration, formatHoursMinutes, formatTime } from '@/utils/format'
import {
  applyBrowseView,
  BROWSE_SORT_LABELS,
  getBrowseProgress,
  type BrowseSort,
  type BrowseView
} from './browseView';

interface DateBrowserProps {
  onFileSelect: (fileId: number, startTime?: number) => void;
  /**
   * Held by the caller so the operator's filter survives a trip into a file
   * and back -- the browse table unmounts on that navigation.
   */
  view: BrowseView;
  onViewChange: (view: BrowseView) => void;
}

const SORT_OPTIONS: BrowseSort[] = ['date-desc', 'unreviewed-desc'];

/** Shared by the library bar and the per-file bars, so they read alike. */
function progressBarColor(percentage: number): string {
  if (percentage >= 80) return 'bg-green-500';
  if (percentage >= 50) return 'bg-yellow-500';
  return 'bg-orange-500';
}

// Hash a string to a colour, so the same song keeps its colour across the UI.
function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = hash % 360;
  return `hsl(${hue}, 70%, 85%)`;
}

function stringToTextColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = hash % 360;
  return `hsl(${hue}, 70%, 35%)`;
}

export function DateBrowser({ onFileSelect, view, onViewChange }: DateBrowserProps) {
  const { data, isLoading, error } = useFilesByDate();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#9198E5]"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center">
        <div className="text-red-600 font-medium">Error loading files</div>
        <div className="text-sm text-gray-600 mt-2">
          {error instanceof Error ? error.message : 'Unknown error'}
        </div>
      </div>
    );
  }

  if (!data || data.dates.length === 0) {
    // Everything synced can still be empty recordings, which we filter out.
    // Say so, otherwise this reads as a failed sync.
    const onlyEmptyRecordings = (data?.emptyRecordingCount ?? 0) > 0;
    return (
      <div className="p-8 text-center">
        <div className="text-gray-600">No MIDI files found</div>
        <div className="text-sm text-gray-500 mt-2">
          {onlyEmptyRecordings
            ? `${data!.emptyRecordingCount} synced file${data!.emptyRecordingCount !== 1 ? 's' : ''} contain no notes and are hidden`
            : 'Run a sync to download files from your Jamcorder device'}
        </div>
      </div>
    );
  }

  // Flatten files out of their date groups, then order them for display.
  const allFiles = data.dates.flatMap(({ date, files }) =>
    files.map((file: FileByDateRow) => ({ ...file, date }))
  );
  const visibleFiles = applyBrowseView(allFiles, view);
  const progress = getBrowseProgress(allFiles);

  const totalFiles = allFiles.length;
  const visibleCount = visibleFiles.length;
  const emptyRecordingCount = data.emptyRecordingCount ?? 0;

  return (
    <div className="space-y-4">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">
          MIDI Files
        </h1>
        <p className="text-gray-600 mt-2">
          {view.incompleteOnly
            ? `${visibleCount} of ${totalFiles} file${totalFiles !== 1 ? 's' : ''}`
            : `${totalFiles} file${totalFiles !== 1 ? 's' : ''}`}
          {emptyRecordingCount > 0 && (
            <span
              className="text-gray-500"
              title="Assets the Jamcorder opened and closed without recording any notes. They stay synced but are not annotatable."
            >
              {' '}&middot; {emptyRecordingCount} empty recording{emptyRecordingCount !== 1 ? 's' : ''} hidden
            </span>
          )}
        </p>
      </div>

      <div
        data-testid="library-progress"
        className="border border-gray-200 rounded-lg shadow-sm bg-white p-4"
      >
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-sm font-medium text-gray-700">Annotation progress</h2>
          <span className="text-2xl font-bold text-gray-900">{progress.percentage}%</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2 mt-2">
          <div
            className={`h-2 rounded-full transition-all ${progressBarColor(progress.percentage)}`}
            style={{ width: `${progress.percentage}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-gray-500">
          {formatHoursMinutes(progress.annotatedSeconds)} of {formatHoursMinutes(progress.totalSeconds)}
          {' '}&middot; {progress.completeFileCount} of {progress.fileCount} file
          {progress.fileCount !== 1 ? 's' : ''} complete
        </p>
      </div>

      <div className="border rounded-lg overflow-hidden shadow-sm bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700">Sort</span>
            <div className="flex rounded-lg bg-gray-100 p-0.5">
              {SORT_OPTIONS.map((sort) => (
                <button
                  key={sort}
                  onClick={() => onViewChange({ ...view, sort })}
                  aria-pressed={view.sort === sort}
                  className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    view.sort === sort
                      ? 'bg-gray-900 text-white'
                      : 'text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                  {BROWSE_SORT_LABELS[sort]}
                </button>
              ))}
            </div>
          </div>

          <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={view.incompleteOnly}
              onChange={(event) => onViewChange({ ...view, incompleteOnly: event.target.checked })}
              className="h-4 w-4 accent-gray-900"
            />
            Incomplete only
          </label>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left py-3 px-4 font-semibold text-gray-700 text-sm">Date</th>
                <th className="text-left py-3 px-4 font-semibold text-gray-700 text-sm">Filename</th>
                <th className="text-left py-3 px-4 font-semibold text-gray-700 text-sm">Duration</th>
                <th className="text-left py-3 px-4 font-semibold text-gray-700 text-sm">Progress</th>
                <th className="text-left py-3 px-4 font-semibold text-gray-700 text-sm">Unreviewed</th>
                <th className="text-left py-3 px-4 font-semibold text-gray-700 text-sm">Songs</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visibleFiles.map((file) => (
                <tr
                  key={file.id}
                  onClick={() => onFileSelect(file.id)}
                  className="hover:bg-gray-50 cursor-pointer transition-colors"
                >
                  <td className="py-3 px-4 text-sm text-gray-600 whitespace-nowrap">
                    {formatDate(file.date)}
                  </td>
                  <td className="py-3 px-4">
                    <div className="text-sm text-gray-500">{file.filename}</div>
                  </td>
                  <td className="py-3 px-4 text-sm text-gray-600 whitespace-nowrap">
                    {formatDuration(file.totalDuration)}
                  </td>
                  <td className="py-3 px-4">
                    {file.isComplete ? (
                      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
                        Complete
                      </span>
                    ) : file.annotationCount > 0 ? (
                      <div className="flex items-center gap-2">
                        <div className="flex-1 min-w-[100px]">
                          <div className="w-full bg-gray-200 rounded-full h-2">
                            <div
                              className={`h-2 rounded-full transition-all ${progressBarColor(file.percentageAnnotated)}`}
                              style={{ width: `${file.percentageAnnotated}%` }}
                            />
                          </div>
                        </div>
                        <span className="text-xs font-medium text-gray-600 whitespace-nowrap">
                          {file.percentageAnnotated}%
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">No annotations</span>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        window.location.hash = `/reviews?fileId=${file.id}`;
                      }}
                      className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold transition-colors ${
                        !file.isComplete && file.unreviewedPredictionCount > 0
                          ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                      title={`Open prediction review queue for this file${
                        file.unreviewedPredictionCount > 0 && file.unreviewedPredictionCoverage > 0
                          ? ` · ${file.unreviewedPredictionCoverage}% of duration covered`
                          : ''
                      }`}
                    >
                      {file.unreviewedPredictionCount}
                      {file.unreviewedPredictionCount > 0 && file.unreviewedPredictionCoverage > 0 && (
                        <>
                          <span className="mx-1 opacity-50" aria-hidden>·</span>
                          <span>{file.unreviewedPredictionCoverage}%</span>
                        </>
                      )}
                    </button>
                  </td>
                  <td className="py-3 px-4">
                    {file.annotations && file.annotations.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {file.annotations.map((annotation, idx) => (
                          <button
                            key={idx}
                            onClick={(e) => {
                              e.stopPropagation()
                              onFileSelect(file.id, annotation.start_time)
                            }}
                            className="inline-block px-2 py-1 text-xs rounded-full font-medium hover:opacity-80 transition-opacity cursor-pointer"
                            style={{
                              backgroundColor: stringToColor(annotation.song_name),
                              color: stringToTextColor(annotation.song_name)
                            }}
                            title={`Jump to ${annotation.song_name} at ${formatTime(annotation.start_time)}`}
                          >
                            {annotation.song_name} {formatTime(annotation.start_time)}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <ChevronRight className="w-5 h-5 text-gray-400" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {view.incompleteOnly && visibleCount === 0 && (
          <div className="px-4 py-12 text-center">
            <div className="text-gray-600">Every file is marked complete</div>
            <button
              onClick={() => onViewChange({ ...view, incompleteOnly: false })}
              className="mt-2 text-sm font-medium text-[#9198E5] hover:text-[#E66465]"
            >
              Show all {totalFiles} file{totalFiles !== 1 ? 's' : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
