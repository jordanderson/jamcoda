import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AnalyticsPage } from './AnalyticsPage'
import { installApiMock } from '@/test/mocks/apiMock'
import { renderWithProviders } from '@/test/utils/renderWithProviders'

function songRow(
  annotationId: number,
  songName: string,
  dateRecorded: string,
  duration: number
) {
  return {
    annotation_id: annotationId,
    file_id: 1,
    song_name: songName,
    start_time: 0,
    end_time: duration,
    filename: 'Jmx-A00001.mid',
    date_recorded: dateRecorded,
    created_at: 0,
    updated_at: 0
  }
}

// Data extent: 2026-01-05 … 2026-03-09, so the default 90d preset covers all.
const songs = {
  songs: [
    songRow(1, 'Bethena', '2026-03-09', 600),
    songRow(2, 'Bethena', '2026-03-08', 300),
    songRow(3, 'Maple Leaf Rag', '2026-03-09', 120),
    songRow(4, 'Old Tune', '2026-01-05', 60)
  ]
}

describe('AnalyticsPage', () => {
  let api: ReturnType<typeof installApiMock>

  beforeEach(() => {
    api = installApiMock([
      { method: 'GET', path: '/api/annotations/songs', handler: () => ({ body: songs }) }
    ])
  })

  afterEach(() => {
    api.restore()
  })

  it('ranks songs by annotated time and shows KPIs', async () => {
    renderWithProviders(<AnalyticsPage />)

    // Bethena appears in the KPI card, bar chart, legend and table.
    const bethenas = await screen.findAllByText('Bethena')
    expect(bethenas.length).toBeGreaterThan(0)

    // Total 1080s = 18m in the KPI card; January row in range by default.
    expect(screen.getByText('18m')).toBeInTheDocument()
    expect(screen.getAllByText('Old Tune').length).toBeGreaterThan(0)

    // Ranked by time: Bethena (900s) before Maple Leaf Rag (120s) in the table.
    const rows = screen.getAllByRole('row').map((row) => row.textContent ?? '')
    const bethenaRow = rows.findIndex((text) => text.includes('15m'))
    const mapleRow = rows.findIndex((text) => text.includes('2m'))
    expect(bethenaRow).toBeGreaterThanOrEqual(0)
    expect(mapleRow).toBeGreaterThanOrEqual(0)
    expect(bethenaRow).toBeLessThan(mapleRow)
  })

  it('narrows to the selected preset range', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AnalyticsPage />)
    await screen.findAllByText('Bethena')

    // Last 30d of the data extent excludes the January row (1020s = 17m).
    await user.click(screen.getByRole('button', { name: 'Last 30d' }))
    expect(await screen.findByText('17m')).toBeInTheDocument()
    expect(screen.queryByText('Old Tune')).not.toBeInTheDocument()
  })

  it('links songs to the filtered Songs view', async () => {
    renderWithProviders(<AnalyticsPage />)
    await screen.findAllByText('Bethena')

    const tableLink = screen.getAllByRole('link', { name: 'Bethena' })[0]
    expect(tableLink).toHaveAttribute('href', '#/songs?song=Bethena')

    const chartLink = screen.getAllByRole('link', { name: 'Open Bethena in Songs' })[0]
    expect(chartLink).toHaveAttribute('href', '#/songs?song=Bethena')
  })

  it('regroups the trend when periodicity changes', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AnalyticsPage />)
    await screen.findAllByText('Bethena')

    // Default 90d range auto-resolves to week; force month and expect a
    // monthly bucket label in the trend chart.
    await user.click(screen.getByRole('button', { name: 'Month' }))
    expect(await screen.findByText("Mar '26")).toBeInTheDocument()
  })
})
