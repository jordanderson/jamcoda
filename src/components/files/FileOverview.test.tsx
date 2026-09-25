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

  it('keeps resize handles inside a wide enough span', () => {
    render(
      <SpanRow
        durationSec={1000}
        onSeek={vi.fn()}
        onResizePointerDown={vi.fn()}
        minSpanPercent={5}
        spans={[{ key: 'wide', label: 'Wide', start: 0, end: 100 }]}
      />
    )
    // The handles are flush inside the span's edges, not straddling them.
    expect(screen.getByRole('button', { name: 'Resize start of Wide' })).toHaveStyle({ left: '0%' })
    expect(screen.getByRole('button', { name: 'Resize end of Wide' })).toHaveClass('-translate-x-full')
  })

  it('hides resize handles when a span is too narrow to hold them inside', () => {
    render(
      <SpanRow
        durationSec={1000}
        onSeek={vi.fn()}
        onResizePointerDown={vi.fn()}
        minSpanPercent={5}
        spans={[{ key: 'narrow', label: 'Narrow', start: 0, end: 10 }]}
      />
    )
    // 1% of the row is below the 5% floor, so it is click-only.
    expect(screen.queryByRole('button', { name: 'Resize start of Narrow' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resize end of Narrow' })).not.toBeInTheDocument()
  })

  it('leaves a span that merely touches the next one at its true width', () => {
    render(
      <SpanRow
        durationSec={100}
        onSeek={vi.fn()}
        spans={[
          { key: 'a', label: 'First', start: 0, end: 50 },
          { key: 'b', label: 'Second', start: 50, end: 100 }
        ]}
      />
    )
    // Abutting spans are separated by each span's white right border, so
    // neither has to give up any of the time it actually covers.
    expect(screen.getByRole('button', { name: 'First' })).toHaveStyle({ left: '0%', width: '50%' })
    expect(screen.getByRole('button', { name: 'Second' })).toHaveStyle({ left: '50%', width: '50%' })
  })

  it('stops the narrow-span clamp at the start of the next span', () => {
    render(
      <SpanRow
        durationSec={100}
        onSeek={vi.fn()}
        spans={[
          { key: 'a', label: 'Blip', start: 10, end: 10.2 },
          { key: 'b', label: 'Next', start: 10.25, end: 20 }
        ]}
      />
    )
    // The 0.4% floor would put Blip's right edge at 10.4s, across Next's start
    // at 10.25s. It grows into the room it has and stops there.
    expect(screen.getByRole('button', { name: 'Blip' })).toHaveStyle({ left: '10%', width: '0.25%' })
    expect(screen.getByRole('button', { name: 'Next' })).toHaveStyle({ left: '10.25%' })
  })

  it('still draws a short span that abuts the next one', () => {
    render(
      <SpanRow
        durationSec={3600}
        onSeek={vi.fn()}
        spans={[
          { key: 'a', label: 'Short', start: 100, end: 104 },
          { key: 'b', label: 'Next', start: 104, end: 400 }
        ]}
      />
    )
    // There is no room to clamp into, but a span never renders narrower than
    // the time it covers: a four-second song is still on the bar, and still
    // clickable, rather than collapsing to nothing against its neighbor.
    const short = screen.getByRole('button', { name: 'Short' })
    const width = Number.parseFloat(short.style.width)
    expect(width).toBeGreaterThan(0)
    expect(width).toBeCloseTo((4 / 3600) * 100, 6)
  })

  it('renders spans that genuinely overlap as overlapping', () => {
    render(
      <SpanRow
        durationSec={100}
        onSeek={vi.fn()}
        spans={[
          { key: 'a', label: 'First', start: 10, end: 20 },
          { key: 'b', label: 'Second', start: 15, end: 25 }
        ]}
      />
    )
    // Second begins before First ends, so the overlap is real and neither
    // span is squeezed.
    expect(screen.getByRole('button', { name: 'First' })).toHaveStyle({ left: '10%', width: '10%' })
    expect(screen.getByRole('button', { name: 'Second' })).toHaveStyle({ left: '15%', width: '10%' })
  })

  it('keeps the handles on a wide span that abuts a neighbor', () => {
    render(
      <SpanRow
        durationSec={1000}
        onSeek={vi.fn()}
        onResizePointerDown={vi.fn()}
        minSpanPercent={5}
        spans={[
          { key: 'a', label: 'Abutting', start: 0, end: 50 },
          { key: 'b', label: 'Next', start: 50, end: 100 }
        ]}
      />
    )
    // Whether a span can be resized is about the span, not about who it sits
    // next to: Abutting is exactly at the 5% floor and keeps its handles.
    expect(screen.getByRole('button', { name: 'Abutting' })).toHaveStyle({ width: '5%' })
    expect(screen.getByRole('button', { name: 'Resize end of Abutting' })).toBeInTheDocument()
  })

  it('pads the click target without painting past the span\'s real end', () => {
    render(
      <SpanRow
        durationSec={3600}
        onSeek={vi.fn()}
        spans={[{ key: 'a', label: 'Blip', start: 10, end: 10.2 }]}
      />
    )
    // The button (the click target) still gets the 0.4% floor so it stays
    // hittable, but the colored, labeled box inside it — what a viewer reads
    // as "this is where the span is" — stops at the span's true 0.2s width.
    // Otherwise a short span at a zoomed-out scale can visually reach into
    // whatever a neighboring row draws well after it actually ends.
    const button = screen.getByRole('button', { name: 'Blip' })
    expect(button).toHaveStyle({ width: '0.4%' })
    const naturalWidthPercent = (0.2 / 3600) * 100
    const visible = button.querySelector('span')
    const visibleWidth = Number.parseFloat(visible?.style.width ?? '')
    expect(visibleWidth).toBeCloseTo((naturalWidthPercent / 0.4) * 100, 6)
  })

  it('wraps a long label instead of pushing the row taller', () => {
    render(
      <SpanRow
        durationSec={100}
        onSeek={vi.fn()}
        spans={[{ key: 'a', label: 'Christmas Time Is Here', start: 0, end: 10 }]}
      />
    )
    // The span is absolutely positioned at the row's full height, so a second
    // line is clipped at a line boundary rather than growing the bar.
    const span = screen.getByRole('button', { name: 'Christmas Time Is Here' })
    expect(span).toHaveClass('h-full', 'overflow-hidden')
    expect(span).not.toHaveClass('whitespace-nowrap')
    expect(screen.getByText('Christmas Time Is Here')).toHaveClass('line-clamp-2')
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
      { keys: '[MouseLeft>]', target: endHandle, coords: { x: 120, y: 0 } },
      { target: endHandle, coords: { x: 180, y: 0 } },
      { keys: '[/MouseLeft]' }
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

describe('FileOverview evidence', () => {
  const withParts = [{
    id: 8, songName: 'Moonlight Sonata', startTime: 100, endTime: 200, confidence: 0.5,
    parts: [
      { startTime: 100, endTime: 150, basis: 'anchor', meanRank: 0 },
      { startTime: 150, endTime: 162, basis: 'bridge', meanRank: 4 },
      { startTime: 162, endTime: 200, basis: 'anchor', meanRank: 0 }
    ]
  }]

  it('hatches the stretch worth a listen, names it on hover, and explains the marks', () => {
    render(
      <FileOverview currentTime={0} durationSec={240} annotations={annotations} predictions={withParts} onSeek={vi.fn()} />
    )
    expect(screen.getAllByTestId('listen-stretch')).toHaveLength(1)
    expect(screen.getByTitle(/1 stretch worth a listen: 2:30–2:42/)).toBeInTheDocument()
    expect(screen.getByText('worth a listen')).toBeInTheDocument()
  })

  it('shows no legend when no prediction carries evidence', () => {
    render(
      <FileOverview currentTime={0} durationSec={240} annotations={annotations} predictions={predictions} onSeek={vi.fn()} />
    )
    expect(screen.queryByText('worth a listen')).not.toBeInTheDocument()
    expect(screen.queryByTestId('listen-stretch')).not.toBeInTheDocument()
  })
})
