import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FileOverview, SpanRow } from './FileOverview'

const annotations = [
  { id: 1, song_name: 'Bethena', start_time: 0, end_time: 60 },
  { id: 2, song_name: 'Waltz in A', start_time: 120, end_time: 180 }
]
const predictions = [
  { id: 7, songName: 'Maple Leaf Rag', startTime: 60, endTime: 90, confidence: 0.5 }
]

describe('FileOverview', () => {
  it('stays out of the way when there is nothing to show', () => {
    const { container: noDuration } = render(
      <FileOverview currentTime={0} durationSec={0} annotations={annotations} predictions={predictions} onSeek={vi.fn()} />
    )
    expect(noDuration).toBeEmptyDOMElement()

    const { container: noContent } = render(
      <FileOverview currentTime={0} durationSec={240} annotations={[]} predictions={[]} onSeek={vi.fn()} />
    )
    expect(noContent).toBeEmptyDOMElement()
  })

  it('counts each layer and hides the prediction row when there are none', () => {
    render(
      <FileOverview currentTime={0} durationSec={240} annotations={annotations} predictions={predictions} onSeek={vi.fn()} />
    )
    expect(screen.getByText('Annotations (2)')).toBeInTheDocument()
    expect(screen.getByText('Predictions (1)')).toBeInTheDocument()

    render(
      <FileOverview currentTime={0} durationSec={240} annotations={annotations} predictions={[]} onSeek={vi.fn()} />
    )
    expect(screen.queryByText('Predictions (0)')).not.toBeInTheDocument()
  })

  it('places every layer against the same duration, so rows line up', () => {
    render(
      <FileOverview currentTime={0} durationSec={240} annotations={annotations} predictions={predictions} onSeek={vi.fn()} />
    )
    // 0-60s of 240s is the first quarter; 60-90s starts a quarter in.
    expect(screen.getByRole('button', { name: 'Bethena' })).toHaveStyle({ left: '0%', width: '25%' })
    expect(screen.getByRole('button', { name: 'Waltz in A' })).toHaveStyle({ left: '50%', width: '25%' })
    expect(screen.getByRole('button', { name: 'Maple Leaf Rag' })).toHaveStyle({ left: '25%', width: '12.5%' })
  })

  it('jumps the playhead to the start of whatever is clicked', async () => {
    const onSeek = vi.fn()
    render(
      <FileOverview currentTime={0} durationSec={240} annotations={annotations} predictions={predictions} onSeek={onSeek} />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Waltz in A' }))
    expect(onSeek).toHaveBeenCalledWith(120)

    await userEvent.click(screen.getByRole('button', { name: 'Maple Leaf Rag' }))
    expect(onSeek).toHaveBeenCalledWith(60)
  })

  it('labels the clock in minutes and seconds, on the spans and the axis', () => {
    render(
      <FileOverview currentTime={0} durationSec={240} annotations={annotations} predictions={[]} onSeek={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: 'Waltz in A' }))
      .toHaveAttribute('title', 'Waltz in A — 2:00 to 3:00')
    expect(screen.getByText('4:00')).toBeInTheDocument()
    expect(screen.getByText('1:00')).toBeInTheDocument()
  })
})

describe('SpanRow', () => {
  it('keeps a sub-second span wide enough to click', () => {
    render(
      <SpanRow
        durationSec={3600}
        onSeek={vi.fn()}
        spans={[{ key: 'a', label: 'Blip', start: 10, end: 10.2 }]}
      />
    )
    // 0.2s of an hour rounds to nothing; the floor keeps it hittable.
    expect(screen.getByRole('button', { name: 'Blip' })).toHaveStyle({ width: '0.4%' })
  })

  it('shows the empty label only when asked and only when empty', () => {
    const { rerender } = render(
      <SpanRow durationSec={100} onSeek={vi.fn()} spans={[]} emptyLabel="Nothing here" />
    )
    expect(screen.getByText('Nothing here')).toBeInTheDocument()

    rerender(
      <SpanRow
        durationSec={100}
        onSeek={vi.fn()}
        spans={[{ key: 'a', label: 'Song', start: 0, end: 10 }]}
        emptyLabel="Nothing here"
      />
    )
    expect(screen.queryByText('Nothing here')).not.toBeInTheDocument()
  })
})

describe('FileOverview annotation resize', () => {
  it('renders grab handles on each annotation edge', () => {
    render(
      <FileOverview currentTime={0} durationSec={240} annotations={annotations} predictions={[]} onSeek={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: 'Resize start of Bethena' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resize end of Bethena' })).toBeInTheDocument()
  })

  it('commits the dragged edge back through onAnnotationResize', async () => {
    const user = userEvent.setup()
    const onAnnotationResize = vi.fn().mockResolvedValue(undefined)
    render(
      <FileOverview
        currentTime={0}
        durationSec={240}
        annotations={[{ id: 5, song_name: 'Blip', start_time: 0, end_time: 60 }]}
        predictions={[]}
        onSeek={vi.fn()}
        onAnnotationResize={onAnnotationResize}
      />
    )
    const endHandle = screen.getByRole('button', { name: 'Resize end of Blip' })
    await user.pointer([
      { keys: '[PointerLeft>]', target: endHandle, coords: { x: 120 } },
      { keys: '[PointerLeft]', target: endHandle, coords: { x: 180 } },
      { keys: '[/PointerLeft]', target: endHandle, coords: { x: 180 } }
    ])
    expect(onAnnotationResize).toHaveBeenCalled()
    const [id, times] = onAnnotationResize.mock.calls[0]
    expect(id).toBe(5)
    expect(times.endTime).toBeGreaterThan(60)
  })
})

describe('FileOverview playhead', () => {
  const props = {
    durationSec: 240,
    annotations,
    predictions,
    onSeek: vi.fn()
  }

  it('marks the playing position on every bar, against the same axis', () => {
    render(<FileOverview {...props} currentTime={60} />)
    const heads = screen.getAllByTestId('overview-playhead')
    // One per bar: annotations and predictions.
    expect(heads).toHaveLength(2)
    for (const head of heads) expect(head).toHaveStyle({ left: '25%' })
  })

  it('moves with the playhead and hides when it is out of range', () => {
    const { rerender } = render(<FileOverview {...props} currentTime={0} />)
    expect(screen.getAllByTestId('overview-playhead')[0]).toHaveStyle({ left: '0%' })

    rerender(<FileOverview {...props} currentTime={180} />)
    expect(screen.getAllByTestId('overview-playhead')[0]).toHaveStyle({ left: '75%' })

    rerender(<FileOverview {...props} currentTime={999} />)
    expect(screen.queryByTestId('overview-playhead')).not.toBeInTheDocument()
  })

  it('does not make the playhead clickable over the spans beneath it', () => {
    render(<FileOverview {...props} currentTime={60} />)
    expect(screen.getAllByTestId('overview-playhead')[0]).toHaveClass('pointer-events-none')
  })
})

describe('FileOverview candidates', () => {
  const run = {
    id: 1,
    label: 'link=bridge',
    request: { segment: {}, decoder: {} },
    segments: [
      { songName: 'Written Take', startTime: 0, endTime: 30, durationSec: 30, confidence: 0.5 }
    ],
    rawSegments: [
      { songName: 'Written Take', startTime: 0, endTime: 30, durationSec: 30, confidence: 0.5 },
      { songName: 'Excluded Take', startTime: 60, endTime: 120, durationSec: 60, confidence: 0.5 }
    ]
  }

  it('draws a previewed run beside the annotations it should be compared to', () => {
    render(
      <FileOverview
        durationSec={240}
        currentTime={0}
        annotations={annotations}
        predictions={[]}
        candidates={[run]}
        onSeek={vi.fn()}
      />
    )
    expect(screen.getByText(/Candidate 1: link=bridge/)).toBeInTheDocument()
    expect(screen.getByText(/1 segments/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Written Take' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Excluded Take' })).not.toBeInTheDocument()
  })

  it('shows the model output before exclusion on a completed file', () => {
    // Nothing can be written to a completed file, so the written shape says
    // nothing; the raw output is what can be checked against the annotations.
    render(
      <FileOverview
        durationSec={240}
        currentTime={0}
        annotations={annotations}
        predictions={[]}
        candidates={[run]}
        isFileComplete
        onSeek={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Excluded Take' })).toBeInTheDocument()
    expect(screen.getByText(/before annotated time is subtracted/)).toBeInTheDocument()
  })

  it('appears for candidates even when there is nothing else to show', () => {
    const { container } = render(
      <FileOverview
        durationSec={240}
        currentTime={0}
        annotations={[]}
        predictions={[]}
        candidates={[run]}
        onSeek={vi.fn()}
      />
    )
    expect(container).not.toBeEmptyDOMElement()
    expect(screen.getByText(/Candidate 1/)).toBeInTheDocument()
  })
})
