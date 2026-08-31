import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import Layout from './components/layout/Layout'
import { ErrorBoundary } from './components/ErrorBoundary'
import { SyncModal } from './components/sync/SyncModal'
import { WelcomeModal } from './components/sync/WelcomeModal'
import { DateBrowser } from './components/files/DateBrowser'
import { DetailPage } from './components/files/DetailPage'
import { PredictionReviewPage } from './components/reviews/PredictionReviewPage'
import { SongsPage } from './components/songs/SongsPage'
import { useSyncStatus } from './hooks/useSyncStatus'
import { useStartSync } from './hooks/useStartSync'
import { useFilesByDate } from './hooks/useFilesByDate'

function AppContent() {
  const [route, setRoute] = useState(window.location.hash.slice(1) || '/browse')
  const [syncId, setSyncId] = useState<string | null>(null)
  const [isWelcomeDismissed, setIsWelcomeDismissed] = useState(false)

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

  const handleStartSync = (full = false) => {
    if (startSync.isPending) return

    startSync.mutate(full, {
      onSuccess: (data) => {
        setSyncId(data.syncId)
        setIsWelcomeDismissed(true)
      }
    })
  }

  const handleSyncComplete = () => {
    setSyncId(null)
    queryClient.invalidateQueries({ queryKey: ['filesByDate'] })
    queryClient.invalidateQueries({ queryKey: ['syncStatus'] })
    // Navigate to browse view
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
        onSync={handleStartSync}
        onDismiss={() => setIsWelcomeDismissed(true)}
      />
      {syncId && <SyncModal syncId={syncId} onComplete={handleSyncComplete} />}
      <Layout onStartSync={handleStartSync} isSyncStarting={startSync.isPending}>
        {route === '/browse' && <DateBrowser onFileSelect={handleFileSelect} />}
        {route.startsWith('/songs') && <SongsPage />}
        {route.startsWith('/reviews') && <PredictionReviewPage />}
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
