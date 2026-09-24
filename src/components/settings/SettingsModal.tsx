import { useState } from 'react'
import { ExternalLink, FolderOpen, RefreshCw, X } from 'lucide-react'
import { useSyncStatus } from '../../hooks/useSyncStatus'
import { useRebuildPredictionModel } from '../../hooks/usePredictionReviews'
import { useSettings } from '../../hooks/useSettings'
import type { Toast } from '../../hooks/useToasts'
import { errorMessage } from '@core/errors'

interface SettingsModalProps {
  isOpen: boolean
  isSyncStarting: boolean
  onStartSync: (full?: boolean) => void
  onClose: () => void
  showToast: (toast: Omit<Toast, 'id'>) => void
}

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

/**
 * Editing the Jamcorder address acts on the desktop app's own configuration.
 * `window.jamcoda` is undefined in a browser and under `npm run electron:dev`,
 * so this renders nothing there.
 *
 * Saving relaunches the app, so it waits out a running sync or model rebuild
 * rather than cutting it short.
 */
function JamcorderUrlControls({ currentUrl, isBusy }: { currentUrl: string; isBusy: boolean }) {
  const [isEditing, setIsEditing] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const bridge = window.jamcoda
  if (!bridge) {
    return null
  }

  const handleSave = async () => {
    const url = urlDraft.trim()
    if (!url || isBusy) return
    setIsSaving(true)
    setError(null)
    try {
      const result = await bridge.setJamcorderUrl(url)
      if (!result.ok) {
        setError(result.error)
        setIsSaving(false)
      }
    } catch (saveError) {
      setError(errorMessage(saveError, 'Could not save the address'))
      setIsSaving(false)
    }
  }

  if (isEditing) {
    return (
      <form
        className="mt-2"
        onSubmit={(e) => {
          e.preventDefault()
          void handleSave()
        }}
      >
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={urlDraft}
            onChange={(e) => {
              setUrlDraft(e.target.value)
              setError(null)
            }}
            placeholder="jamcorder.local"
            aria-label="Jamcorder address"
            className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded"
          />
          <button
            type="submit"
            disabled={isBusy || isSaving || !urlDraft.trim()}
            className="text-xs text-emerald-700 hover:text-emerald-600 font-medium whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Save & restart
          </button>
          <button
            type="button"
            onClick={() => {
              setIsEditing(false)
              setError(null)
            }}
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            Cancel
          </button>
        </div>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
        {isBusy && !error && (
          <p className="mt-1 text-xs text-gray-500">Available once the current sync or model rebuild finishes.</p>
        )}
      </form>
    )
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => {
          setUrlDraft(currentUrl)
          setIsEditing(true)
        }}
        className="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2"
      >
        Change Jamcorder address
      </button>
    </div>
  )
}

/**
 * The library folder holds the database, recordings and model together, so
 * pointing the app at another folder switches all three. Switching relaunches
 * the app, so it waits out a running sync or model rebuild. The controls act
 * on the desktop app's own configuration; in a browser only the path shows.
 */
function LibraryControls({ libraryDir, isBusy }: { libraryDir: string | undefined; isBusy: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const [isChoosing, setIsChoosing] = useState(false)
  const bridge = window.jamcoda

  const handleChoose = async () => {
    if (!bridge || isBusy) return
    setError(null)
    setIsChoosing(true)
    try {
      const result = await bridge.chooseLibraryFolder()
      if (!result.ok) {
        setError(result.error)
        setIsChoosing(false)
      }
    } catch (chooseError) {
      setError(errorMessage(chooseError, 'Could not change the library folder'))
      setIsChoosing(false)
    }
  }

  return (
    <div className="mt-3 text-xs text-gray-500">
      <div className="truncate" title={libraryDir}>{libraryDir ?? '…'}</div>
      {bridge && (
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void bridge.revealDataFolder()}
            className="flex items-center gap-1 text-gray-400 hover:text-gray-600"
          >
            <FolderOpen className="w-3 h-3" />
            Show folder
          </button>
          <button
            type="button"
            onClick={() => void handleChoose()}
            disabled={isBusy || isChoosing}
            className="text-gray-400 hover:text-gray-600 underline underline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Change library folder…
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-red-600">{error}</p>}
      {bridge && isBusy && !error && (
        <p className="mt-1">Changing the library is available once the current sync or model rebuild finishes.</p>
      )}
    </div>
  )
}

export function SettingsModal({ isOpen, isSyncStarting, onStartSync, onClose, showToast }: SettingsModalProps) {
  const { data: syncStatus } = useSyncStatus()
  const { data: settings } = useSettings()
  const rebuildModel = useRebuildPredictionModel()

  const jamcorderHost = (settings?.jamcorderUrl ?? 'http://jamcorder.local').replace(/^https?:\/\//, '')

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
            message: errorMessage(error, 'Failed to rebuild model')
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
          <JamcorderUrlControls
            currentUrl={settings?.jamcorderUrl ?? ''}
            isBusy={isSyncStarting || rebuildModel.isPending}
          />
        </section>

        <section className="mt-6 border-t border-gray-100 pt-6">
          <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Library</h3>
          <LibraryControls
            libraryDir={settings?.libraryDir}
            isBusy={isSyncStarting || rebuildModel.isPending}
          />
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

        <footer className="mt-6 border-t border-gray-100 pt-4 text-center">
          <a
            href="https://github.com/jordanderson/jamcoda"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            About JamCoda
            <ExternalLink className="w-3 h-3" />
          </a>
        </footer>
      </div>
    </div>
  )
}