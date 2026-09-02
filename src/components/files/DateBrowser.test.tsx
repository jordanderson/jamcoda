import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DateBrowser } from './DateBrowser'
import { DEFAULT_BROWSE_VIEW, type BrowseView } from './browseView'
import { installApiMock } from '@/test/mocks/apiMock'
import { renderWithProviders } from '@/test/utils/renderWithProviders'

function row(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    filename: `Jmx-A0000${id}.mid`,
    fileSize: 1024,
    dateRecorded: '2026-02-16',
    isComplete: false,
    completedAt: null,
    annotationCount: 0,
    percentageAnnotated: 0,
    totalDuration: 100,
    annotatedDuration: 0,
    annotations: [],
    unreviewedPredictionCount: 0,
    ...overrides
  }
}

const filesByDate = {
  dates: [
    { date: '2026-02-16', files: [row(1, { unreviewedPredictionCount: 3, unreviewedPredictionCoverage: 42 })] },
    { date: '2026-02-15', files: [row(2, { isComplete: true, unreviewedPredictionCount: 0 })] },
    { date: '2026-02-14', files: [row(3, { unreviewedPredictionCount: 11, unreviewedPredictionCoverage: 0 })] }
  ],
  emptyRecordingCount: 0
}

function renderBrowser(view: BrowseView = DEFAULT_BROWSE_VIEW) {
  const onViewChange = vi.fn()
  const result = renderWithProviders(
    <DateBrowser onFileSelect={vi.fn()} view={view} onViewChange={onViewChange} />
  )
  return { ...result, onViewChange }
}

describe('DateBrowser', () => {
  let api: ReturnType<typeof installApiMock>

  beforeEach(() => {
    api = installApiMock([
      { method: 'GET', path: '/api/files/by-date', handler: () => ({ body: filesByDate }) }
    ])
  })

  afterEach(() => {
    api.restore()
  })

  it('lists every file newest first by default', async () => {
    renderBrowser()

    expect(await screen.findByText('Jmx-A00001.mid')).toBeInTheDocument()
    const filenames = screen.getAllByText(/^Jmx-A0000\d\.mid$/).map((node) => node.textContent)
    expect(filenames).toEqual(['Jmx-A00001.mid', 'Jmx-A00002.mid', 'Jmx-A00003.mid'])
  })

  it('sums library progress, counting a complete file as fully annotated', async () => {
    renderBrowser()

    // Three 100s files; only the complete one counts, so 100 of 300.
    const card = await screen.findByTestId('library-progress')
    expect(within(card).getByText('33%')).toBeInTheDocument()
    expect(card).toHaveTextContent('1m of 5m')
    expect(card).toHaveTextContent('1 of 3 files complete')
  })

  it('keeps library progress on the whole library while the table is filtered', async () => {
    renderBrowser({ sort: 'date-desc', incompleteOnly: true })

    const card = await screen.findByTestId('library-progress')
    expect(within(card).getByText('33%')).toBeInTheDocument()
    expect(card).toHaveTextContent('1 of 3 files complete')
  })

  it('reports the chosen sort back to the caller rather than sorting privately', async () => {
    const user = userEvent.setup()
    const { onViewChange } = renderBrowser()

    await user.click(await screen.findByRole('button', { name: /Most unreviewed/ }))

    expect(onViewChange).toHaveBeenCalledWith({ ...DEFAULT_BROWSE_VIEW, sort: 'unreviewed-desc' })
  })

  it('orders by unreviewed count when the caller asks for it', async () => {
    renderBrowser({ sort: 'unreviewed-desc', incompleteOnly: false })

    await screen.findByText('Jmx-A00003.mid')
    const filenames = screen.getAllByText(/^Jmx-A0000\d\.mid$/).map((node) => node.textContent)
    expect(filenames).toEqual(['Jmx-A00003.mid', 'Jmx-A00001.mid', 'Jmx-A00002.mid'])
  })

  it('shows the share of duration the pending predictions cover in the unreviewed pill', async () => {
    renderBrowser()

    const pill = await screen.findByRole('button', { name: /42%/ })
    expect(pill).toHaveTextContent(/3\s*·\s*42%/)
    expect(pill.getAttribute('title')).toMatch(/42% of duration covered/)
  })

  it('hides complete files and counts what is left when filtering', async () => {
    renderBrowser({ sort: 'date-desc', incompleteOnly: true })

    await screen.findByText('Jmx-A00001.mid')
    expect(screen.queryByText('Jmx-A00002.mid')).not.toBeInTheDocument()
    expect(screen.getByText('2 of 3 files')).toBeInTheDocument()
  })

  it('offers a way back when the filter hides everything', async () => {
    const user = userEvent.setup()
    api.setRoutes([
      {
        method: 'GET',
        path: '/api/files/by-date',
        handler: () => ({
          body: {
            dates: [{ date: '2026-02-15', files: [row(2, { isComplete: true })] }],
            emptyRecordingCount: 0
          }
        })
      }
    ])
    const { onViewChange } = renderBrowser({ sort: 'date-desc', incompleteOnly: true })

    expect(await screen.findByText('Every file is marked complete')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Show all 1 file' }))

    expect(onViewChange).toHaveBeenCalledWith({ sort: 'date-desc', incompleteOnly: false })
  })
})
