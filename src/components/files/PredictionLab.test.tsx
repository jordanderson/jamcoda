import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const MODELS = [
  {
    name: 'model.json', isLibraryModel: true, modelVersion: 'v2.13', createdAt: '2026-09-24T05:01:33.264Z',
    featureCount: 37, chordIoiFeatures: false, labelCount: 85, error: null
  },
  {
    name: 'model-chord-ioi.json', isLibraryModel: false, modelVersion: 'v2.13', createdAt: '2026-09-24T05:05:00.000Z',
    featureCount: 53, chordIoiFeatures: true, labelCount: 85, error: null
  },
  {
    name: 'model-v2.14.json', isLibraryModel: false, modelVersion: null, createdAt: null,
    featureCount: null, chordIoiFeatures: false, labelCount: null,
    error: 'Model was trained with a different feature set'
  }
]

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string) => {
    const body = url.endsWith('/models') ? MODELS : { modelVersion: 'x', segments: [], rawSegments: [] }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

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

describe('PredictionLab model choice', () => {
  const previewBody = () => {
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/run'))
    return JSON.parse((call![1] as RequestInit).body as string)
  }

  it('lists the library models, and will not offer one this build cannot load', async () => {
    renderLab()
    await open()
    const select = screen.getByLabelText('Model')
    expect(await within(select).findByRole('option', { name: /model-chord-ioi.json — v2.13, .*53 features/ })).toBeEnabled()
    expect(within(select).getByRole('option', { name: /model.json \(library model\)/ })).toBeEnabled()
    expect(within(select).getByRole('option', { name: 'model-v2.14.json — cannot load' })).toBeDisabled()
  })

  it('sends the chosen model by name and the hold-out choice with a preview', async () => {
    renderLab()
    await open()
    await within(screen.getByLabelText('Model')).findByRole('option', { name: /model-chord-ioi.json/ })
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'model-chord-ioi.json')
    await userEvent.click(screen.getByRole('checkbox', { name: /Hold this file out/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }))

    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/run'))).toBe(true))
    const body = previewBody()
    expect(body.modelName).toBe('model-chord-ioi.json')
    expect(body.holdOut).toBe(true)
    expect(body.dryRun).toBe(true)
  })

  it('holds a completed file out by default, and an unfinished one not', async () => {
    const { unmount } = renderLab({ isFileComplete: true })
    await open()
    expect(screen.getByRole('checkbox', { name: /Hold this file out/ })).toBeChecked()
    unmount()

    renderLab({ isFileComplete: false })
    await open()
    expect(screen.getByRole('checkbox', { name: /Hold this file out/ })).not.toBeChecked()
  })

  it('applies only a run of the library model as saved', async () => {
    const base = {
      label: 'x', segments: [], rawSegments: [],
      request: { segment: {}, decoder: {} }
    }
    renderLab({
      runs: [
        { ...base, id: 1 },
        { ...base, id: 2, request: { ...base.request, modelName: 'model-chord-ioi.json' } },
        { ...base, id: 3, request: { ...base.request, holdOut: true } }
      ]
    })
    await open()
    const apply = screen.getAllByRole('button', { name: /Apply/ })
    expect(apply[0]).toBeEnabled()
    expect(apply[1]).toBeDisabled()
    expect(apply[2]).toBeDisabled()
  })
})
