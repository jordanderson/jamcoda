import { describe, expect, it, vi } from 'vitest'
import type { PropsWithChildren } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PredictionLab } from './PredictionLab'
import { SETTING_HELP } from './predictionSettingHelp'

function wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const renderLab = (overrides: Partial<Parameters<typeof PredictionLab>[0]> = {}) =>
  render(
    <PredictionLab
      fileId={1}
      durationSec={240}
      currentTime={0}
      annotations={[{ id: 1, song_name: 'Bethena', start_time: 0, end_time: 60 }]}
      currentPredictions={[]}
      isFileComplete={false}
      runs={[]}
      onRunsChange={vi.fn()}
      onSeek={vi.fn()}
      onError={vi.fn()}
      {...overrides}
    />,
    { wrapper }
  )

const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: /Prediction Lab/ }))
}

describe('PredictionLab settings help', () => {
  it('starts collapsed so it does not crowd the page', () => {
    renderLab()
    expect(screen.queryByText('Segment shaping')).not.toBeInTheDocument()
  })

  it('offers an explanation for every setting it exposes, and exposes every one it explains', async () => {
    renderLab()
    await open()
    const helpButtons = screen.getAllByRole('button', { name: /^What does .* do\?$/ })
    // A field added without copy would render a button that opens nothing, so
    // check from the buttons on screen rather than from the copy.
    expect(helpButtons).toHaveLength(Object.keys(SETTING_HELP).length)
    for (const button of helpButtons) {
      const title = button.getAttribute('aria-label')!.replace(/^What does /, '').replace(/ do\?$/, '')
      await userEvent.click(button)
      expect(
        screen.getByRole('heading', { name: title }),
        `no explanation opened for "${title}"`
      ).toBeInTheDocument()
      await userEvent.click(button)
    }
  })

  it('shows and hides an explanation from its own icon', async () => {
    renderLab()
    await open()
    const button = screen.getByRole('button', { name: 'What does Tail leash do?' })

    expect(screen.queryByRole('heading', { name: 'Tail leash' })).not.toBeInTheDocument()
    await userEvent.click(button)
    const heading = screen.getByRole('heading', { name: 'Tail leash' })
    expect(heading).toBeInTheDocument()
    expect(screen.getByText(/median 3.6 seconds past its last anchor/)).toBeInTheDocument()

    await userEvent.click(button)
    expect(screen.queryByRole('heading', { name: 'Tail leash' })).not.toBeInTheDocument()
  })

  it('shows one explanation at a time, and closes from the panel', async () => {
    renderLab()
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'What does Merge gap do?' }))
    await userEvent.click(screen.getByRole('button', { name: 'What does Anchor margin do?' }))

    expect(screen.queryByRole('heading', { name: 'Merge gap' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Anchor margin' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Close explanation' }))
    expect(screen.queryByRole('heading', { name: 'Anchor margin' })).not.toBeInTheDocument()
  })

  it('says plainly which settings the default decoder ignores', async () => {
    renderLab()
    await open()
    for (const title of ['Min window confidence', 'Smoothing']) {
      await userEvent.click(screen.getByRole('button', { name: `What does ${title} do?` }))
      const panel = screen.getByRole('heading', { name: title }).closest('div')?.parentElement
      expect(within(panel as HTMLElement).getByText(/Not used by the anchor decoder/)).toBeInTheDocument()
    }
  })

  it('will not let a completed file be written to', async () => {
    renderLab({ isFileComplete: true })
    await open()
    expect(screen.getByText(/this file is complete, so these are the answer/)).toBeInTheDocument()
  })
})

describe('PredictionLab candidates', () => {
  const run = {
    id: 2,
    label: 'link=bridge',
    request: { segment: {}, decoder: { linkPolicy: 'bridge' as const } },
    segments: [{ songName: 'Bethena', startTime: 0, endTime: 30, durationSec: 30, confidence: 0.5 }],
    rawSegments: []
  }

  it('lists a run handed to it, and hands removal back up', async () => {
    const onRunsChange = vi.fn()
    renderLab({ runs: [run], onRunsChange })
    await open()

    expect(screen.getByText(/Candidate 2: link=bridge/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Discard this candidate' }))
    // State is owned by the page, so the panel reports the change rather than
    // making it — that is what lets the overview draw the same runs.
    expect(onRunsChange).toHaveBeenCalledTimes(1)
    const update = onRunsChange.mock.calls[0][0] as (current: typeof run[]) => typeof run[]
    expect(update([run])).toEqual([])
  })

  it('will not write a candidate to a completed file', async () => {
    renderLab({ runs: [run], isFileComplete: true })
    await open()
    expect(screen.getByRole('button', { name: /Apply/ })).toBeDisabled()
  })

  it('says where else the candidates show up', async () => {
    renderLab({ runs: [run] })
    await open()
    expect(screen.getByText(/appear in the overview beside the piano roll/)).toBeInTheDocument()
  })
})

describe('PredictionLab queue provenance', () => {
  const OLD = 'knn-song-segmenter@2026-09-04T01:47:18.913Z'
  const prediction = { id: 1, songName: 'Maple Leaf Rag', startTime: 0, endTime: 60, confidence: 0.5 }

  it('says where the queue came from, as a readable stamp', async () => {
    renderLab({ currentPredictions: [prediction], queueModelVersion: OLD })
    await open()
    expect(screen.getByText(/stored from 2026-09-04 01:47/)).toBeInTheDocument()
  })

  it('admits when it cannot say', async () => {
    renderLab({ currentPredictions: [prediction] })
    await open()
    expect(screen.getByText(/stored output/)).toBeInTheDocument()
  })

  it('stays quiet about staleness until a preview has said which model it used', async () => {
    // Before any preview there is nothing to compare the queue against, so
    // claiming it is stale would be a guess.
    renderLab({ currentPredictions: [prediction], queueModelVersion: OLD })
    await open()
    expect(screen.queryByText(/written by an older model/)).not.toBeInTheDocument()
  })
})
