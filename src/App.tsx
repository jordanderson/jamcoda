import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import Layout from './components/layout/Layout'
import { ErrorBoundary } from './components/ErrorBoundary'
import { SyncModal } from './components/sync/SyncModal'
import { WelcomeModal } from './components/sync/WelcomeModal'
import { DateBrowser } from './components/files/DateBrowser'
import { DEFAULT_BROWSE_VIEW, type BrowseView } from './components/files/browseView'
import { DetailPage } from './components/files/DetailPage'
import { SongsPage } from './components/songs/SongsPage'
import { AnalyticsPage } from './components/analytics/AnalyticsPage'
import { useSyncStatus } from './hooks/useSyncStatus'
import { useStartSync } from './hooks/useStartSync'
import { useFilesByDate } from './hooks/useFilesByDate'
import { errorMessage } from '@core/errors'

function AppContent() {
  const [route, setRoute] = useState(window.location.hash.slice(1) || '/browse')
  const [syncId, setSyncId] = useState<string | null>(null)
  const [isWelcomeDismissed, setIsWelcomeDismissed] = useState(false)
  // Browse's sort and filter live here, not in the table: opening a file
  // unmounts the table, and losing the filter on every trip back would defeat
  // the point of narrowing to the files still needing work.
  const [browseView, setBrowseView] = useState<BrowseView>(DEFAULT_BROWSE_VIEW)

  const queryClient = useQueryClient()
  const { data: syncStatus } = useSyncStatus()
  const { data: filesByDate, isLoading: isLoadingFiles, error: filesByDateError } = useFilesByDate()
  const startSync = useStartSync()
  const localFileCount = useMemo(
    () => (filesByDate?.dates ?? []).reduce((sum, group) => sum + group.files.length, 0),
    [filesByDate]
  )
  const showWelcomeModal = (
    !isWelcomeDismissed
    && !syncId
    && !isLoadingFiles
    && !filesByDateError
    && syncStatus?.hasNeverSynced === true
    && localFileCount === 0
  )

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(window.location.hash.slice(1) || '/browse')
    }

    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  /**
   * Start a sync, resolving once it is actually running.
   *
   * Callers that opened their own modal await this so they can close exactly
   * when the progress modal takes over, rather than leaving two stacked. It
   * rejects if the device never accepted the request.
   */
  const handleStartSync = async (full = false) => {
    if (startSync.isPending) return

    const { syncId: startedSyncId } = await startSync.mutateAsync(full)
    setSyncId(startedSyncId)
    setIsWelcomeDismissed(true)
  }

  const handleSyncComplete = () => {
    setSyncId(null)
    queryClient.invalidateQueries({ queryKey: ['filesByDate'] })
    queryClient.invalidateQueries({ queryKey: ['syncStatus'] })
    // Navigate to browse view.
    window.location.hash = '/browse'
  }

  const handleFileSelect = (fileId: number, startTime?: number) => {
    const hash = startTime !== undefined
      ? `/detail/${fileId}?time=${startTime}`
      : `/detail/${fileId}`
    window.location.hash = hash
  }

  return (
    <>
      <WelcomeModal
        isOpen={showWelcomeModal}
        isSyncing={startSync.isPending}
        syncError={startSync.error ? errorMessage(startSync.error, 'Failed to start sync') : null}
        onSync={() => {
          // A rejection here is already surfaced through `syncError`.
          void handleStartSync().catch(() => {})
        }}
        onDismiss={() => setIsWelcomeDismissed(true)}
      />
      {syncId && <SyncModal syncId={syncId} onComplete={handleSyncComplete} />}
      <Layout onStartSync={handleStartSync} isSyncStarting={startSync.isPending}>
        {route === '/browse' && (
          <DateBrowser
            onFileSelect={handleFileSelect}
            view={browseView}
            onViewChange={setBrowseView}
          />
        )}
        {route.startsWith('/songs') && <SongsPage />}
        {route.startsWith('/analytics') && <AnalyticsPage />}
        {route.startsWith('/detail/') && (
          <DetailPage fileId={parseInt(route.split('/')[2])} />
        )}
      </Layout>
    </>
  )
}

function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  )
}

export default App
