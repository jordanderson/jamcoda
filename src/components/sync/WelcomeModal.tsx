import { RefreshCw } from 'lucide-react'

interface WelcomeModalProps {
  isOpen: boolean
  isSyncing: boolean
  onSync: () => void
  onDismiss: () => void
}

export function WelcomeModal({ isOpen, isSyncing, onSync, onDismiss }: WelcomeModalProps) {
  if (!isOpen) {
    return null
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
        <h2 className="text-2xl font-bold text-gray-900">Welcome to JamCoda</h2>
        <p className="text-gray-600 mt-3">
          No local MIDI files were found yet. Start by syncing from your Jamcorder device.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onSync}
            disabled={isSyncing}
            className="px-4 py-2 bg-gray-900 hover:bg-gray-800 disabled:bg-gray-500 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
          >
            {isSyncing ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
            {isSyncing ? 'Starting Sync...' : 'Sync from Jamcorder'}
          </button>

          <button
            type="button"
            onClick={onDismiss}
            className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium transition-colors"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}
