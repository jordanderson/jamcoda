import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PianoRollVisualizer } from './PianoRollVisualizer'
import type { NoteSequence } from '@core/midi/noteSequence'

const sequence: NoteSequence = {
  notes: [
    { pitch: 60, velocity: 80, startTime: 0, endTime: 1 },
    { pitch: 64, velocity: 80, startTime: 30, endTime: 31 },
    { pitch: 67, velocity: 80, startTime: 90, endTime: 92 }
  ],
  totalTime: 92
}

const annotations = [
  { id: 1, song_name: 'Blue in Green', start_time: 10, end_time: 40 }
]

describe('PianoRollVisualizer', () => {
  it('renders nothing playable without a sequence', () => {
    render(<PianoRollVisualizer sequence={null} />)

    expect(screen.getByText('No MIDI sequence loaded')).toBeInTheDocument()
  })

  it('shows the playhead in every playback state, not only while playing', () => {
    const { rerender } = render(
      <PianoRollVisualizer sequence={sequence} currentTime={30} isPlaying />
    )
    expect(screen.getByTestId('piano-roll-playhead')).toHaveStyle({ left: '1500px' })

    rerender(<PianoRollVisualizer sequence={sequence} currentTime={30} isPlaying={false} />)
    expect(screen.getByTestId('piano-roll-playhead')).toHaveStyle({ left: '1500px' })

    rerender(<PianoRollVisualizer sequence={sequence} currentTime={0} isPlaying={false} />)
    expect(screen.getByTestId('piano-roll-playhead')).toHaveStyle({ left: '0px' })
  })

  it('re-engages follow when the roll is clicked to seek', async () => {
    const user = userEvent.setup()
    const onTimeClick = vi.fn()
    const onSnapToPlaybackChange = vi.fn()

    render(
      <PianoRollVisualizer
        sequence={sequence}
        snapToPlayback={false}
        onTimeClick={onTimeClick}
        onSnapToPlaybackChange={onSnapToPlaybackChange}
      />
    )

    await user.click(document.querySelector('svg') as SVGSVGElement)

    expect(onSnapToPlaybackChange).toHaveBeenCalledWith(true)
    expect(onTimeClick).toHaveBeenCalled()
  })

  it('re-engages follow when an annotation chip is used to jump', async () => {
    const user = userEvent.setup()
    const onTimeClick = vi.fn()
    const onSnapToPlaybackChange = vi.fn()

    render(
      <PianoRollVisualizer
        sequence={sequence}
        annotations={annotations}
        snapToPlayback={false}
        onTimeClick={onTimeClick}
        onSnapToPlaybackChange={onSnapToPlaybackChange}
      />
    )

    await user.click(screen.getByRole('button', { name: /Blue in Green \(10.0 to 40.0 seconds\)/ }))

    expect(onSnapToPlaybackChange).toHaveBeenCalledWith(true)
    expect(onTimeClick).toHaveBeenCalledWith(10)
  })

  it('clears the hover readout when region-select mode is entered', async () => {
    const user = userEvent.setup()
    const onHoverTimeChange = vi.fn()

    const { rerender } = render(
      <PianoRollVisualizer sequence={sequence} onHoverTimeChange={onHoverTimeChange} />
    )

    await user.hover(document.querySelector('svg') as SVGSVGElement)
    onHoverTimeChange.mockClear()

    rerender(
      <PianoRollVisualizer
        sequence={sequence}
        isAnnotationMode
        onHoverTimeChange={onHoverTimeChange}
      />
    )

    expect(onHoverTimeChange).toHaveBeenCalledWith(null)
  })

  it('widens the timeline to cover overlays that outrun the last note', () => {
    // An annotation or prediction can extend past the sequence. The roll has
    // to be wide enough to scroll to it.
    render(
      <PianoRollVisualizer
        sequence={sequence}
        annotations={[{ id: 2, song_name: 'Coda', start_time: 80, end_time: 150 }]}
      />
    )

    const content = screen.getByTestId('piano-roll-scroll').firstElementChild as HTMLElement
    expect(content).toHaveStyle({ minWidth: '7500px' })
  })

  it('renders checkpoint flags only once their times are set', () => {
    const { rerender } = render(<PianoRollVisualizer sequence={sequence} />)
    expect(screen.queryByText('Start')).not.toBeInTheDocument()
    expect(screen.queryByText('End')).not.toBeInTheDocument()

    rerender(
      <PianoRollVisualizer sequence={sequence} startCheckpoint={0} endCheckpoint={12} />
    )
    // Zero is a real checkpoint, not an absent one.
    expect(screen.getByText('Start')).toBeInTheDocument()
    expect(screen.getByText('End')).toBeInTheDocument()
  })

  it('resets the scroll position when a different file is loaded', () => {
    const { rerender } = render(<PianoRollVisualizer sequence={sequence} />)
    const scroller = screen.getByTestId('piano-roll-scroll')
    scroller.scrollLeft = 2500

    rerender(<PianoRollVisualizer sequence={{ ...sequence, totalTime: 120 }} />)

    expect(scroller.scrollLeft).toBe(0)
  })
})
