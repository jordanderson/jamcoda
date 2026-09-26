import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PropsWithChildren } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { installApiMock, type MockRoute } from '@/test/mocks/apiMock'
import type { FileDetailAnnotation, FileDetailResponse } from '@/api/localTypes'
import { usePredictionReviews } from './usePredictionReviews'
import { useFileDetail } from './useFileDetail'
import { useUniqueSongNames, useUpdateAnnotation } from './useAnnotations'

const FILE_ID = 7

function annotation(overrides: Partial<FileDetailAnnotation> = {}): FileDetailAnnotation {
  return {
    id: 1,
    file_id: FILE_ID,
    song_name: 'Song A',
    start_time: 10,
    end_time: 20,
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides
  }
}

function fileDetail(annotations: FileDetailAnnotation[]): FileDetailResponse {
  return {
    id: FILE_ID,
    filename: 'Jmx-A00007.mid',
    dateRecorded: '2026-01-11',
    fileSize: 1024,
    localPath: 'data/midi/2026-01-11/Jmx-A00007.mid',
    jamcorderPath: '/jamcorder/Jmx-A00007.mid',
    syncedAt: 1700000000,
    isComplete: false,
    completedAt: null,
    percentageAnnotated: 40,
    annotations,
    bookmarks: [],
    skips: []
  }
}

/**
 * The server's stored rows, so the detail route and the update route agree the
 * way the real backend does. `percentageAnnotated` moves with the edit, as it
 * does server-side.
 */
let stored: FileDetailAnnotation[]
let percentage: number
let absorbOnUpdate: number[]
let updateStatus: number
let api: ReturnType<typeof installApiMock>
/** Held open to keep a save in flight while the test inspects the cache. */
let releaseUpdate: (() => void) | null
/** Same, for the file refetch that follows a save. */
let releaseDetail: (() => void) | null

const routes: MockRoute[] = [
  {
    method: 'GET',
    path: `/api/files/${FILE_ID}`,
    handler: async () => {
      if (releaseDetail) {
        await new Promise<void>((resolve) => {
          const pending = releaseDetail!
          releaseDetail = () => {
            pending()
            resolve()
          }
        })
      }
      return { body: { ...fileDetail(stored), percentageAnnotated: percentage } }
    }
  },
  {
    method: 'PUT',
    path: '/api/annotations/1',
    handler: async (request) => {
      if (releaseUpdate) {
        await new Promise<void>((resolve) => {
          const pending = releaseUpdate!
          releaseUpdate = () => {
            pending()
            resolve()
          }
        })
      }
      if (updateStatus !== 200) {
        return { status: updateStatus, body: { error: 'Label not found' } }
      }
      const patch = request.json<{ startTime?: number; endTime?: number; songName?: string }>()
      stored = stored
        .filter((item) => !absorbOnUpdate.includes(item.id))
        .map((item) => (
          item.id === 1
            ? {
              ...item,
              song_name: patch.songName ?? item.song_name,
              start_time: patch.startTime ?? item.start_time,
              end_time: patch.endTime ?? item.end_time,
              updated_at: 1700000500
            }
            : item
        ))
      percentage = 55
      return { body: { ...stored.find((item) => item.id === 1), absorbedIds: absorbOnUpdate } }
    }
  },
  { method: 'GET', path: '/api/annotations/song-names/unique', handler: () => ({ body: ['Song A'] }) },
  {
    method: 'GET',
    path: /^\/api\/prediction-reviews(\?|$)/,
    handler: () => ({ body: { reviews: [], total: 0 } })
  },
  {
    method: 'GET',
    path: '/api/prediction-reviews/rebuild-status',
    handler: () => ({ body: { modelExists: false, hasPendingChanges: false } })
  },
  { method: 'GET', path: '/api/files/by-date', handler: () => ({ body: { files: [] } }) },
  { method: 'GET', path: '/api/annotations/songs', handler: () => ({ body: { songs: [] } }) }
]

function renderResize() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } }
  })

  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }

  // Every distinct `annotations` array the caller sees. The detail page's
  // per-annotation gap and flourish scans are memoised on this identity, so
  // each new one is a full rescan of the file -- over a second on a long
  // recording.
  const annotationIdentities: FileDetailAnnotation[][] = []

  // The detail page holds all of these at once; that is what turned one
  // resize into four parallel requests.
  const view = renderHook(() => {
    const detail = useFileDetail(FILE_ID)
    if (detail.data && detail.data.annotations !== annotationIdentities[annotationIdentities.length - 1]) {
      annotationIdentities.push(detail.data.annotations)
    }
    return {
      detail,
      reviews: usePredictionReviews({ fileId: FILE_ID, includePromoted: false, limit: 500 }),
      songNames: useUniqueSongNames(),
      update: useUpdateAnnotation()
    }
  }, { wrapper: Wrapper })

  return { ...view, queryClient, annotationIdentities }
}

beforeEach(() => {
  stored = [annotation(), annotation({ id: 2, start_time: 40, end_time: 50 })]
  percentage = 40
  absorbOnUpdate = []
  updateStatus = 200
  releaseUpdate = null
  releaseDetail = null
  api = installApiMock(routes)
})

afterEach(() => {
  api.restore()
})

function reviewCalls(): number {
  return api.getCalls().filter((call) => call.url.startsWith('/api/prediction-reviews')).length
}

describe('useUpdateAnnotation', () => {
  it('shows the new bounds while the save is still in flight', async () => {
    let release = () => {}
    releaseUpdate = () => { release() }
    const held = new Promise<void>((resolve) => { release = resolve })

    const { result } = renderResize()
    await waitFor(() => expect(result.current.detail.data).toBeDefined())

    // Deliberately not awaited: this is the window in which a drag-resize used
    // to snap the chip back to where it started.
    const saving = result.current.update.mutateAsync({ id: 1, data: { startTime: 10, endTime: 32 } })

    await waitFor(() => {
      expect(result.current.detail.data?.annotations[0].end_time).toBe(32)
    })
    // Shown from the local patch alone -- the file has not been refetched.
    expect(api.countCalls('GET', `/api/files/${FILE_ID}`)).toBe(1)

    releaseUpdate!()
    await held
    await saving
  })

  it('applies the saved row from the response, so the refetch changes nothing', async () => {
    const { result, annotationIdentities } = renderResize()
    await waitFor(() => expect(result.current.detail.data).toBeDefined())
    expect(annotationIdentities).toHaveLength(1)

    // Hold the refetch that the save triggers, so anything the cache shows
    // below came from the save's own response.
    let release = () => {}
    releaseDetail = () => { release() }
    const heldDetail = new Promise<void>((resolve) => { release = resolve })

    await result.current.update.mutateAsync({ id: 1, data: { startTime: 10, endTime: 32 } })

    // The saved row, `updated_at` included -- not just the times that were
    // asked for, and not waiting on the file to come back.
    await waitFor(() => {
      expect(result.current.detail.data?.annotations[0].updated_at).toBe(1700000500)
    })
    expect(result.current.detail.data?.annotations[0].end_time).toBe(32)
    const settled = annotationIdentities.length

    releaseDetail!()
    await heldDetail
    await waitFor(() => expect(result.current.detail.data?.percentageAnnotated).toBe(55))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The refetch is deep-equal to what the response already wrote, so
    // structural sharing hands back the same array and the detail page's
    // per-annotation gap and flourish scans do not run again for it.
    expect(annotationIdentities).toHaveLength(settled)
  })

  it('leaves an annotation with notes deep-equal to the refetched row', async () => {
    // `notes` is absent on a row without one and present on a row with one.
    // The patch has to reproduce that exactly: react-query compares key
    // counts, so a stray `notes: undefined` would make every save cost an
    // extra rescan of the roll.
    stored = [annotation({ notes: 'take 2' }), annotation({ id: 2, start_time: 40, end_time: 50 })]

    const { result, annotationIdentities } = renderResize()
    await waitFor(() => expect(result.current.detail.data).toBeDefined())

    await result.current.update.mutateAsync({ id: 1, data: { startTime: 10, endTime: 32 } })
    await waitFor(() => expect(result.current.detail.data?.percentageAnnotated).toBe(55))
    const settled = annotationIdentities.length
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result.current.detail.data?.annotations[0].notes).toBe('take 2')
    expect(annotationIdentities).toHaveLength(settled)
  })

  it('does not refetch song names or prediction reviews for a plain resize', async () => {
    const { result } = renderResize()
    await waitFor(() => expect(result.current.detail.data).toBeDefined())

    await result.current.update.mutateAsync({ id: 1, data: { startTime: 10, endTime: 32 } })
    await waitFor(() => expect(result.current.detail.data?.percentageAnnotated).toBe(55))

    // Both are mounted and were fetched once on mount; neither is refetched.
    expect(api.countCalls('GET', '/api/annotations/song-names/unique')).toBe(1)
    expect(reviewCalls()).toBe(1)
  })

  it('refetches prediction reviews when the edit absorbed another annotation', async () => {
    absorbOnUpdate = [2]
    const { result } = renderResize()
    await waitFor(() => expect(result.current.detail.data).toBeDefined())
    await waitFor(() => expect(result.current.reviews.data).toBeDefined())
    const before = reviewCalls()

    await result.current.update.mutateAsync({ id: 1, data: { startTime: 10, endTime: 45 } })

    // A merge re-points the promotion on any review promoted into the absorbed
    // row, so the review lists genuinely are stale.
    await waitFor(() => expect(reviewCalls()).toBeGreaterThan(before))
    // And the absorbed row is gone once the refetch lands.
    await waitFor(() => expect(result.current.detail.data?.annotations).toHaveLength(1))
  })

  it('puts the stored bounds back when the save fails', async () => {
    updateStatus = 404
    const { result } = renderResize()
    await waitFor(() => expect(result.current.detail.data).toBeDefined())

    await expect(
      result.current.update.mutateAsync({ id: 1, data: { startTime: 10, endTime: 32 } })
    ).rejects.toThrow()

    await waitFor(() => {
      expect(result.current.detail.data?.annotations[0].end_time).toBe(20)
    })
  })
})
