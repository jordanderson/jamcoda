import { useState } from 'react'
import { ClipboardCheck, Library, Music, RefreshCw } from 'lucide-react'
import { useSyncStatus } from '../../hooks/useSyncStatus'
import { useSoundfontCacheStatus } from '../../hooks/useSoundfontCacheStatus'
import { useRebuildPredictionModel, useRebuildStatus } from '../../hooks/usePredictionReviews'
import type { RebuildStatusResponse } from '../../api/localTypes'

interface SidebarProps {
  onStartSync: (full?: boolean) => void
  isSyncStarting: boolean
}

const jamcorderHost = (import.meta.env.JAMCORDER_URL || 'http://jamcorder.local').replace(/^https?:\/\//, '')

function buildRebuildBadgeTitle(status: RebuildStatusResponse | undefined): string {
  if (!status) return 'Rebuild the segmentation model from annotations'
  const parts: string[] = []
  if (status.pendingAnnotationCount > 0) {
    parts.push(
      `${status.pendingAnnotationCount} annotation${status.pendingAnnotationCount === 1 ? '' : 's'} changed since the model was built`
    )
  }
  if (status.missingLabels.length > 0) {
    const preview = status.missingLabels.slice(0, 3).join(', ')
    const more = status.missingLabels.length > 3 ? '…' : ''
    parts.push(`${status.missingLabels.length} new song label${status.missingLabels.length === 1 ? '' : 's'}: ${preview}${more}`)
  }
  return `Model is stale — ${parts.join('; ')}. Run Rebuild Model to retrain.`
}

export default function Sidebar({ onStartSync, isSyncStarting }: SidebarProps) {
  const currentRoute = window.location.hash.slice(1) || '/browse'
  const { data: syncStatus } = useSyncStatus()
  const rebuildModel = useRebuildPredictionModel()
  const rebuildStatus = useRebuildStatus()
  const [mlFeedback, setMlFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [reRunUnsure, setReRunUnsure] = useState(false)
  const {
    isSupported: isSoundfontCacheSupported,
    isRegistered: isSoundfontCacheRegistered,
    cachedAssetCount,
    isChecking: isCheckingSoundfontCache,
    refresh: refreshSoundfontCache
  } = useSoundfontCacheStatus()

  const navItems = [
    { id: 'browse', label: 'Local Library', icon: Library, path: '/browse' },
    { id: 'songs', label: 'Songs', icon: Music, path: '/songs' },
    { id: 'reviews', label: 'Review Predictions', icon: ClipboardCheck, path: '/reviews' },
  ]

  const handleNavClick = (path: string) => {
    window.location.hash = path
  }

  const handleSyncClick = (full = false) => {
    onStartSync(full)
  }

  const handleRebuildModel = () => {
    setMlFeedback(null)
    rebuildModel.mutate(
      { reRunUnsure },
      {
        onSuccess: (result) => {
          const reScored = result.reRunFileCount > 0
            ? `; re-scored ${result.reRunResults.length} file${result.reRunResults.length === 1 ? '' : 's'} with pending predictions${result.reRunErrors.length > 0 ? ` (${result.reRunErrors.length} failed)` : ''}`
            : '';
          setMlFeedback({
            type: 'success',
            message: `Model rebuilt (${result.filesUsed} files, ${result.annotationsUsed} annotations)${reScored}`
          })
        },
        onError: (error) => {
          setMlFeedback({
            type: 'error',
            message: error instanceof Error ? error.message : 'Failed to rebuild model'
          })
        }
      }
    )
  }

  const formatLastSync = (timestamp: number | null) => {
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

  const rebuildStatusData = rebuildStatus.data
  const rebuildPending = rebuildStatusData?.modelExists && rebuildStatusData.hasPendingChanges
  const rebuildBadgeCount = rebuildStatusData?.pendingAnnotationCount || rebuildStatusData?.missingLabels.length || 0

  return (
    <aside className="w-64 bg-gray-900 text-white h-screen flex flex-col">
      <div className="p-6 border-b border-gray-800">
        <h1 className="text-2xl font-bold text-white">
          JamCoda
        </h1>
        <p className="text-sm text-gray-400 mt-1">Jamcorder Practice Journal</p>
      </div>

      <nav className="flex-1 p-4">
        <ul className="space-y-2">
          {navItems.map((item) => {
            const IconComponent = item.icon
            return (
              <li key={item.id}>
                <button
                  onClick={() => handleNavClick(item.path)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                    currentRoute.startsWith(item.path)
                      ? 'bg-gray-800 text-white'
                      : 'text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  <IconComponent className="w-5 h-5" />
                  <span className="font-medium">{item.label}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="p-4 border-t border-gray-800 space-y-3">
        <button
          onClick={handleRebuildModel}
          disabled={rebuildModel.isPending}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:bg-emerald-900 disabled:cursor-not-allowed text-white rounded-lg transition-colors text-sm font-medium"
        >
          {rebuildModel.isPending ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              Rebuilding Model...
            </>
          ) : (
            <>
              <RefreshCw className="w-4 h-4" />
              Rebuild Model
              {rebuildPending && (
                <span
                  title={buildRebuildBadgeTitle(rebuildStatusData)}
                  className="ml-1 rounded-full bg-emerald-500 px-2 py-0.5 text-xs font-bold leading-none text-emerald-950"
                >
                  {rebuildBadgeCount}
                </span>
              )}
            </>
          )}
        </button>
        <label
          className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-200 cursor-pointer select-none"
          title="Re-run predictions over files whose unpromoted queue is entirely 'unsure' after saving the model. Can take a long time."
        >
          <input
            type="checkbox"
            checked={reRunUnsure}
            onChange={(e) => setReRunUnsure(e.target.checked)}
            disabled={rebuildModel.isPending}
            className="w-3.5 h-3.5 accent-emerald-600"
          />
          Re-score pending predictions
        </label>
        <button
          onClick={() => handleSyncClick()}
          disabled={isSyncStarting}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:bg-gray-900 disabled:cursor-not-allowed text-white rounded-lg transition-colors text-sm font-medium"
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
          onClick={() => handleSyncClick(true)}
          disabled={isSyncStarting}
          title="Re-examine every asset on the device, ignoring the high-water mark"
          className="w-full text-left px-1 text-xs text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
        >
          Full re-sync (re-check all device files)
        </button>
        <div className="text-xs text-gray-500 space-y-1">
          {mlFeedback && (
            <div className={mlFeedback.type === 'success' ? 'text-green-300' : 'text-red-300'}>
              {mlFeedback.message}
            </div>
          )}
          <div>Last sync: {formatLastSync(syncStatus?.lastSyncAt ?? null)}</div>
          <div>Connected to {jamcorderHost}</div>
          <div className="flex items-center gap-2">
            <span>
              Soundfont cache:{' '}
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
                className="text-gray-400 hover:text-gray-200 transition-colors"
                title="Refresh soundfont cache status"
              >
                <RefreshCw className={`w-3 h-3 ${isCheckingSoundfontCache ? 'animate-spin' : ''}`} />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}
