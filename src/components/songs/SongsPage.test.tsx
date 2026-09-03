import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SongsPage } from './SongsPage'
import { installApiMock } from '@/test/mocks/apiMock'
import { renderWithProviders } from '@/test/utils/renderWithProviders'

function songRow(annotationId: number, songName: string, dateRecorded: string, duration = 120) {
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

const songs = {
  songs: [
    songRow(1, 'Bethena', '2026-03-09'),
    songRow(2, 'Bethena', '2026-03-08'),
    songRow(3, 'Maple Leaf Rag', '2026-03-07')
  ]
}

function bodyRowTexts(): string[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.textContent ?? '')
}

describe('SongsPage song filter', () => {
  let api: ReturnType<typeof installApiMock>

  beforeEach(() => {
    api = installApiMock([
      { method: 'GET', path: '/api/annotations/songs', handler: () => ({ body: songs }) },
      {
        method: 'GET',
        path: '/api/annotations/song-names/unique',
        handler: () => ({ body: ['Bethena', 'Maple Leaf Rag'] })
      }
    ])
  })

  afterEach(() => {
    api.restore()
    window.location.hash = '#/browse'
  })

  it('prefilters to the ?song= query param', async () => {
    window.location.hash = '#/songs?song=Bethena'
    renderWithProviders(<SongsPage />)

    await screen.findByRole('table')
    const texts = bodyRowTexts()
    expect(texts.length).toBe(2)
    expect(texts.every((text) => text.includes('Bethena'))).toBe(true)
    // Duration column: each 120s segment renders as 2:00.
    expect(texts.every((text) => text.includes('2:00'))).toBe(true)
    expect(screen.getByRole('combobox', { name: 'Filter by song' })).toHaveValue('Bethena')
  })

  it('shows all songs without a param and syncs the dropdown back to the hash', async () => {
    const user = userEvent.setup()
    window.location.hash = '#/songs?song=Bethena'
    renderWithProviders(<SongsPage />)
    await screen.findByRole('table')

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by song' }),
      ''
    )

    expect(window.location.hash).toBe('#/songs')
    const texts = bodyRowTexts()
    expect(texts.length).toBe(3)
    expect(texts.some((text) => text.includes('Maple Leaf Rag'))).toBe(true)
  })

  it('encodes song names with spaces in the hash', async () => {
    const user = userEvent.setup()
    window.location.hash = '#/songs'
    renderWithProviders(<SongsPage />)
    await screen.findByRole('table')

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by song' }),
      'Maple Leaf Rag'
    )

    expect(window.location.hash).toBe('#/songs?song=Maple%20Leaf%20Rag')
    const texts = bodyRowTexts()
    expect(texts.length).toBe(1)
    expect(texts[0]).toContain('Maple Leaf Rag')
  })

  it('sorts longest first when the Duration header is clicked', async () => {
    const user = userEvent.setup()
    api.setRoutes([
      {
        method: 'GET',
        path: '/api/annotations/songs',
        handler: () => ({
          body: {
            songs: [
              songRow(1, 'Short Song', '2026-03-09', 60),
              songRow(2, 'Long Song', '2026-03-08', 600),
              songRow(3, 'Mid Song', '2026-03-07', 180)
            ]
          }
        })
      },
      {
        method: 'GET',
        path: '/api/annotations/song-names/unique',
        handler: () => ({ body: ['Long Song', 'Mid Song', 'Short Song'] })
      }
    ])
    window.location.hash = '#/songs'
    renderWithProviders(<SongsPage />)
    await screen.findByRole('table')

    await user.click(screen.getByRole('button', { name: 'Duration' }))

    const texts = bodyRowTexts()
    expect(texts.length).toBe(3)
    expect(texts[0]).toContain('Long Song')
    expect(texts[1]).toContain('Mid Song')
    expect(texts[2]).toContain('Short Song')

    // Clicking again reverses to shortest first.
    await user.click(screen.getByRole('button', { name: 'Duration' }))
    const reversed = bodyRowTexts()
    expect(reversed[0]).toContain('Short Song')
    expect(reversed[2]).toContain('Long Song')
  })
})
