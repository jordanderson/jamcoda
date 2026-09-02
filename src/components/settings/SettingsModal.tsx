import { RefreshCw, X } from 'lucide-react'
import { useSyncStatus } from '../../hooks/useSyncStatus'
import { useSoundfontCacheStatus } from '../../hooks/useSoundfontCacheStatus'
import { useRebuildPredictionModel } from '../../hooks/usePredictionReviews'
import type { Toast } from '../../hooks/useToasts'

interface SettingsModalProps {
  isOpen: boolean
  isSyncStarting: boolean
  onStartSync: (full?: boolean) => void
  onClose: () => void
  showToast: (toast: Omit<Toast, 'id'>) => void
}

const jamcorderHost = (import.meta.env.JAMCORDER_URL || 'http://jamcorder.local').replace(/^https?:\/\//, '')

function formatLastSync(timestamp: number | null): string {
  if (!timestamp) return 'Never'
  const date = new Date(timestamp * 1000)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  return `${diffDays}d ago`
}

export function SettingsModal({ isOpen, isSyncStarting, onStartSync, onClose, showToast }: SettingsModalProps) {
  const { data: syncStatus } = useSyncStatus()
  const {
    isSupported: isSoundfontCacheSupported,
    isRegistered: isSoundfontCacheRegistered,
    cachedAssetCount,
    isChecking: isCheckingSoundfontCache,
    refresh: refreshSoundfontCache
  } = useSoundfontCacheStatus()
  const rebuildModel = useRebuildPredictionModel()

  const handleRebuildWithRescore = () => {
    rebuildModel.mutate(
      { reRunUnsure: true },
      {
        onSuccess: (result) => {
          const reScored = result.reRunFileCount > 0
            ? `; re-scored ${result.reRunResults.length} file${result.reRunResults.length === 1 ? '' : 's'} with pending predictions${result.reRunErrors.length > 0 ? ` (${result.reRunErrors.length} failed)` : ''}`
            : '';
          showToast({
            type: 'success',
            message: `Model rebuilt (${result.filesUsed} files, ${result.annotationsUsed} annotations)${reScored}`
          })
        },
        onError: (error) => {
          showToast({
            type: 'error',
            message: error instanceof Error ? error.message : 'Failed to rebuild model'
          })
        }
      }
    )
  }

  if (!isOpen) {
    return null
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold text-gray-900">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Close settings"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <section className="mt-6">
          <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Sync</h3>
          <button
            type="button"
            onClick={() => onStartSync()}
            disabled={isSyncStarting}
            className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2 bg-gray-900 hover:bg-gray-800 disabled:bg-gray-500 disabled:cursor-not-allowed text-white rounded-lg transition-colors text-sm font-medium"
          >
            {isSyncStarting ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Syncing...
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4" />
                Sync Now
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => onStartSync(true)}
            disabled={isSyncStarting}
            title="Re-examine every asset on the device, ignoring the high-water mark"
            className="mt-2 w-full text-left px-1 text-xs text-gray-500 hover:text-gray-700 transition-colors disabled:opacity-50"
          >
            Full re-sync (re-check all device files)
          </button>
          <div className="mt-3 text-xs text-gray-500 space-y-1">
            <div>Last sync: {formatLastSync(syncStatus?.lastSyncAt ?? null)}</div>
            <div>Connected to {jamcorderHost}</div>
          </div>
        </section>

        <section className="mt-6 border-t border-gray-100 pt-6">
          <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Model</h3>
          <button
            type="button"
            onClick={handleRebuildWithRescore}
            disabled={rebuildModel.isPending}
            className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-lg transition-colors text-sm font-medium"
          >
            {rebuildModel.isPending ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Rebuilding & re-scoring...
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4" />
                Rebuild Model + Re-score
              </>
            )}
          </button>
          <p className="mt-2 text-xs text-gray-500">
            Rebuilds the segmentation model from annotations, then re-runs predictions over
            files whose unpromoted queue is entirely 'unsure'. Can take a long time.
          </p>
        </section>

        <section className="mt-6 border-t border-gray-100 pt-6">
          <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Soundfont cache</h3>
          <div className="mt-3 flex items-center gap-2 text-sm text-gray-600">
            <span>
              {isSoundfontCacheSupported
                ? `${cachedAssetCount} asset${cachedAssetCount === 1 ? '' : 's'}${isSoundfontCacheRegistered ? '' : ' (worker inactive)'}`
                : 'unsupported'}
            </span>
            {isSoundfontCacheSupported && (
              <button
                type="button"
                onClick={() => {
                  void refreshSoundfontCache()
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
                title="Refresh soundfont cache status"
              >
                <RefreshCw className={`w-3 h-3 ${isCheckingSoundfontCache ? 'animate-spin' : ''}`} />
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}