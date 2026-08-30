import { useEffect } from 'react';
import { CheckCircle, XCircle } from 'lucide-react';
import { useSyncProgress } from '../../hooks/useSyncProgress';

interface SyncModalProps {
  syncId: string | null;
  onComplete: () => void;
}

export function SyncModal({ syncId, onComplete }: SyncModalProps) {
  const { data: progress } = useSyncProgress(syncId, true);

  useEffect(() => {
    if (progress?.status === 'completed') {
      setTimeout(onComplete, 2000); // Auto-close after 2s
    }
  }, [progress?.status, onComplete]);

  if (!progress) return null;

  const isDiscovering = progress.filesFound === 0 && progress.status === 'in_progress';
  const percentage = progress.filesFound > 0
    ? (progress.filesDownloaded / progress.filesFound) * 100
    : 0;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-8 max-w-md w-full shadow-xl">
        <h2 className="text-2xl font-bold mb-4 text-gray-900">
          Syncing MIDI Files
        </h2>

        {isDiscovering ? (
          <div className="mb-4">
            <div className="flex items-center justify-center py-4">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mr-3"></div>
              <span className="text-gray-700 font-medium">Discovering files on server...</span>
            </div>
          </div>
        ) : (
          <div className="mb-4">
            <div className="flex justify-between text-sm mb-2">
              <span className="font-medium">
                {progress.filesDownloaded} of {progress.filesFound} files
                {progress.filesFound === 0 && progress.status === 'completed' ? ' (no new files)' : ''}
              </span>
              <span className="font-medium">{percentage.toFixed(0)}%</span>
            </div>

            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-gray-900 h-2 rounded-full transition-all duration-300"
                style={{ width: `${percentage}%` }}
              />
            </div>
          </div>
        )}

        {progress.currentFile && (
          <p className="text-sm text-gray-600 truncate">
            Downloading: <span className="font-medium">{progress.currentFile}</span>
          </p>
        )}

        {progress.status === 'completed' && (
          <p className="text-green-600 font-medium mt-4 flex items-center">
            <CheckCircle className="w-5 h-5 mr-2" />
            {progress.filesFound === 0
              ? 'All files are up to date!'
              : `Sync completed successfully! ${progress.filesDownloaded} file${progress.filesDownloaded !== 1 ? 's' : ''} downloaded.`
            }
          </p>
        )}

        {progress.status === 'error' && (
          <div className="mt-4">
            <p className="text-red-600 font-medium flex items-center">
              <XCircle className="w-5 h-5 mr-2" />
              Sync failed
            </p>
            {progress.errors.length > 0 && (
              <div className="mt-2 text-sm text-gray-700 max-h-40 overflow-y-auto">
                {progress.errors.map((err: { file: string; error: string }, i: number) => (
                  <div key={i} className="py-1">
                    <span className="font-medium">{err.file}:</span> {err.error}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
