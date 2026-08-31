import { useFilesByDate } from '@/hooks/useFilesByDate';
import { ChevronRight } from 'lucide-react';
import type { FileByDateRow } from '@/api/localTypes';
import { formatDate, formatDuration, formatTime } from '@/utils/format'

interface DateBrowserProps {
  onFileSelect: (fileId: number, startTime?: number) => void;
}

// Hash string to color for consistent song colors
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

export function DateBrowser({ onFileSelect }: DateBrowserProps) {
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
    return (
      <div className="p-8 text-center">
        <div className="text-gray-600">No MIDI files found</div>
        <div className="text-sm text-gray-500 mt-2">
          Run a sync to download files from your Jamcorder device
        </div>
      </div>
    );
  }

  // Flatten files from all dates
  const allFiles = data.dates.flatMap(({ date, files }) =>
    files.map((file: FileByDateRow) => ({ ...file, date }))
  ).sort((a, b) => b.date.localeCompare(a.date)); // Sort by date descending

  const totalFiles = allFiles.length;

  return (
    <div className="space-y-4">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">
          MIDI Files
        </h1>
        <p className="text-gray-600 mt-2">
          {totalFiles} file{totalFiles !== 1 ? 's' : ''}
        </p>
      </div>

      <div className="border rounded-lg overflow-hidden shadow-sm bg-white">
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
              {allFiles.map((file) => (
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
                              className={`h-2 rounded-full transition-all ${
                                file.percentageAnnotated >= 80 ? 'bg-green-500' :
                                file.percentageAnnotated >= 50 ? 'bg-yellow-500' :
                                'bg-orange-500'
                              }`}
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
                      title="Open prediction review queue for this file"
                    >
                      {file.unreviewedPredictionCount}
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
      </div>
    </div>
  );
}
