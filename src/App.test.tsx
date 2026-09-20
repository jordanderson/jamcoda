import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { installApiMock, type MockRoute } from './test/mocks/apiMock'
import { renderWithProviders } from './test/utils/renderWithProviders'

/** One synced recording, enough to get past the welcome modal. */
const filesByDateFixture = {
  dates: [
    {
      date: '2026-02-16',
      files: [
        {
          id: 1,
          filename: 'Sample.mid',
          fileSize: 1234,
          dateRecorded: '2026-02-16',
          isComplete: false,
          completedAt: null,
          annotationCount: 0,
          percentageAnnotated: 0,
          totalDuration: 100,
          annotatedDuration: 0,
          annotations: [],
          unreviewedPredictionCount: 0,
        },
      ],
    },
  ],
}

function buildRoutes(options?: {
  hasNeverSynced?: boolean
  filesByDate?: unknown
  syncStartResponse?: unknown
  syncProgressResponse?: unknown
}): MockRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/sync/status',
      handler: () => ({
        body: {
          lastSyncAt: null,
          lastSyncFileCount: 0,
          hasNeverSynced: options?.hasNeverSynced ?? true,
        },
      }),
    },
    {
      method: 'GET',
      path: '/api/files/by-date',
      handler: () => ({
        body: options?.filesByDate ?? { dates: [] },
      }),
    },
    {
      method: 'POST',
      path: '/api/sync/start',
      handler: () => ({
        body: options?.syncStartResponse ?? { syncId: 'sync-1', status: 'in_progress' },
      }),
    },
    {
      method: 'GET',
      path: '/api/prediction-reviews/rebuild-status',
      handler: () => ({
        body: { isStale: false, pendingAnnotationCount: 0, missingLabels: [] },
      }),
    },
    {
      method: 'GET',
      path: /\/api\/sync\/progress\/.+$/,
      handler: () => ({
        body: options?.syncProgressResponse ?? {
          syncId: 'sync-1',
          status: 'in_progress',
          filesFound: 2,
          filesDownloaded: 0,
          currentFile: 'example.mid',
          errors: [],
        },
      }),
    },
  ]
}

describe('App startup sync flow', () => {
  let api: ReturnType<typeof installApiMock>

  beforeEach(() => {
    window.location.hash = '/browse'
    api = installApiMock([])
  })

  afterEach(() => {
    api.restore()
  })

  it('shows welcome modal on first launch with no local files and does not auto-sync', async () => {
    api.setRoutes(buildRoutes())

    renderWithProviders(<App />)

    expect(await screen.findByText('Welcome to JamCoda')).toBeInTheDocument()
    expect(api.countCalls('POST', '/api/sync/start')).toBe(0)
  })

  it('starts sync from the welcome modal button and shows sync progress modal', async () => {
    api.setRoutes(buildRoutes())
    const user = userEvent.setup()

    renderWithProviders(<App />)

    const syncButton = await screen.findByRole('button', { name: 'Sync from Jamcorder' })
    await user.click(syncButton)

    await waitFor(() => {
      expect(api.countCalls('POST', '/api/sync/start')).toBe(1)
    })
    expect(await screen.findByText('Syncing MIDI Files')).toBeInTheDocument()
  })

  it('closes the settings modal when a sync starts, so the two do not stack', async () => {
    api.setRoutes(buildRoutes({ hasNeverSynced: false, filesByDate: filesByDateFixture }))
    const user = userEvent.setup()

    renderWithProviders(<App />)

    await user.click(await screen.findByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sync Now' }))

    expect(await screen.findByText('Syncing MIDI Files')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('keeps the settings modal open and reports when a sync fails to start', async () => {
    api.setRoutes([
      ...buildRoutes({ hasNeverSynced: false, filesByDate: filesByDateFixture })
        .filter((route) => route.path !== '/api/sync/start'),
      {
        method: 'POST',
        path: '/api/sync/start',
        handler: () => ({ status: 503, body: { error: 'Device unreachable' } }),
      },
    ])
    const user = userEvent.setup()

    renderWithProviders(<App />)

    await user.click(await screen.findByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Sync Now' }))

    expect(await screen.findByText(/Device unreachable|Failed to start sync/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.queryByText('Syncing MIDI Files')).not.toBeInTheDocument()
  })

  it('skips welcome modal when local files already exist', async () => {
    api.setRoutes(buildRoutes({ filesByDate: filesByDateFixture }))

    renderWithProviders(<App />)

    expect(await screen.findByText('MIDI Files')).toBeInTheDocument()
    expect(screen.queryByText('Welcome to JamCoda')).not.toBeInTheDocument()
  })
})
