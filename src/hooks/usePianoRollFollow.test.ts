import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usePianoRollFollow } from './usePianoRollFollow'

/**
 * The follow state machine across its transitions: stopping, starting again,
 * seeking while paused, and scrolling by hand.
 *
 * jsdom does no layout, so the container's metrics are stubbed. It also emits
 * no scroll events of its own, which lets each test say explicitly whether a
 * scroll came from the app or from the user.
 */

const CLIENT_WIDTH = 1000
const SCROLL_WIDTH = 10_000
/** `FOLLOW_ANCHOR` (0.35) of the viewport. */
const ANCHOR_PX = 350

function createContainer(): HTMLDivElement {
  const container = document.createElement('div')
  Object.defineProperty(container, 'clientWidth', { value: CLIENT_WIDTH, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 200, configurable: true })
  Object.defineProperty(container, 'clientTop', { value: 0, configurable: true })
  Object.defineProperty(container, 'scrollWidth', { value: SCROLL_WIDTH, configurable: true })
  container.getBoundingClientRect = () => ({
    top: 0, left: 0, right: CLIENT_WIDTH, bottom: 200,
    width: CLIENT_WIDTH, height: 200, x: 0, y: 0, toJSON: () => ({})
  })
  document.body.appendChild(container)
  return container
}

interface HookProps {
  playheadX: number
  isPlaying: boolean
  enabled: boolean
  suspended?: boolean
}

describe('usePianoRollFollow', () => {
  let container: HTMLDivElement
  let onUserScroll: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    vi.useFakeTimers()
    container = createContainer()
    onUserScroll = vi.fn<() => void>()
  })

  afterEach(() => {
    vi.useRealTimers()
    container.remove()
  })

  function render(initial: HookProps) {
    return renderHook(
      (props: HookProps) => usePianoRollFollow({
        container,
        onUserScroll,
        ...props
      }),
      { initialProps: initial }
    )
  }

  /** Let the animation loop run to convergence. */
  function runFrames(count = 120) {
    act(() => {
      vi.advanceTimersByTime(count * 16)
    })
  }

  it('scrolls the playhead to the anchor during playback', () => {
    render({ playheadX: 5000, isPlaying: true, enabled: true })
    runFrames()

    expect(container.scrollLeft).toBeCloseTo(5000 - ANCHOR_PX, 0)
  })

  it('leaves the view alone while the playhead is still short of the anchor', () => {
    render({ playheadX: 100, isPlaying: true, enabled: true })
    runFrames()

    expect(container.scrollLeft).toBe(0)
  })

  it('does not scroll at all when follow is off', () => {
    container.scrollLeft = 1234
    render({ playheadX: 5000, isPlaying: true, enabled: false })
    runFrames()

    expect(container.scrollLeft).toBe(1234)
  })

  it('does not scroll while an annotation is being resized', () => {
    container.scrollLeft = 1234
    render({ playheadX: 5000, isPlaying: true, enabled: true, suspended: true })
    runFrames()

    expect(container.scrollLeft).toBe(1234)
  })

  it('follows again after stop and restart', () => {
    const { rerender } = render({ playheadX: 5000, isPlaying: true, enabled: true })
    runFrames()
    expect(container.scrollLeft).toBeCloseTo(5000 - ANCHOR_PX, 0)

    // Stop: the playhead rewinds to zero and playback ends.
    rerender({ playheadX: 0, isPlaying: false, enabled: true })
    runFrames()
    expect(container.scrollLeft).toBe(0)

    // Play again from the top.
    rerender({ playheadX: 0, isPlaying: true, enabled: true })
    runFrames(5)
    expect(container.scrollLeft).toBe(0)

    rerender({ playheadX: 6000, isPlaying: true, enabled: true })
    runFrames()
    expect(container.scrollLeft).toBeCloseTo(6000 - ANCHOR_PX, 0)

    // Nothing in that sequence looked like a user scroll.
    expect(onUserScroll).not.toHaveBeenCalled()
  })

  it('animates a seek made while paused', () => {
    // Paused there are no playback frames to ride on, so the input change
    // itself must wake the loop.
    const { rerender } = render({ playheadX: 0, isPlaying: false, enabled: true })
    runFrames(5)

    rerender({ playheadX: 8000, isPlaying: false, enabled: true })
    runFrames()

    expect(container.scrollLeft).toBeCloseTo(8000 - ANCHOR_PX, 0)
  })

  it('parks the animation loop once settled while paused', () => {
    render({ playheadX: 5000, isPlaying: false, enabled: true })
    runFrames()
    expect(container.scrollLeft).toBeCloseTo(5000 - ANCHOR_PX, 0)

    // Parked means nothing reclaims the scroll, so the page stays idle between
    // seeks rather than holding a frame callback open for the whole session.
    container.scrollLeft = 42
    runFrames(60)
    expect(container.scrollLeft).toBe(42)
  })

  it('keeps the loop alive while playing, since the target keeps moving', () => {
    render({ playheadX: 5000, isPlaying: true, enabled: true })
    runFrames()

    // No prop change: the running loop must pull the view back on its own,
    // which is what keeps playback tracked between renders.
    container.scrollLeft = 0
    runFrames()
    expect(container.scrollLeft).toBeCloseTo(5000 - ANCHOR_PX, 0)
  })

  it('does not mistake its own scrolling for the user', () => {
    render({ playheadX: 5000, isPlaying: true, enabled: true })
    runFrames()

    // Every scroll the container emits while following is ours.
    act(() => {
      container.dispatchEvent(new Event('scroll'))
      container.dispatchEvent(new Event('scroll'))
    })

    expect(onUserScroll).not.toHaveBeenCalled()
  })

  it('releases follow when the user wheels the roll', () => {
    render({ playheadX: 5000, isPlaying: true, enabled: true })
    runFrames()

    act(() => {
      container.dispatchEvent(new Event('wheel'))
      container.dispatchEvent(new Event('scroll'))
    })

    expect(onUserScroll).toHaveBeenCalledTimes(1)
  })

  it('releases follow on a touch drag', () => {
    render({ playheadX: 5000, isPlaying: true, enabled: true })
    runFrames()

    act(() => {
      container.dispatchEvent(new Event('touchmove'))
      container.dispatchEvent(new Event('scroll'))
    })

    expect(onUserScroll).toHaveBeenCalledTimes(1)
  })

  it('releases follow on a scrollbar drag but not on a click in the roll', () => {
    render({ playheadX: 5000, isPlaying: true, enabled: true })
    runFrames()

    // A press inside the content box is a seek, so the scroll it causes is
    // ours and must not undo the jump that was just asked for.
    act(() => {
      container.dispatchEvent(new PointerEvent('pointerdown', { clientY: 50 }))
      container.dispatchEvent(new Event('scroll'))
    })
    expect(onUserScroll).not.toHaveBeenCalled()

    // A press below the content box is on the horizontal scrollbar.
    act(() => {
      container.dispatchEvent(new PointerEvent('pointerdown', { clientY: 250 }))
      container.dispatchEvent(new Event('scroll'))
    })
    expect(onUserScroll).toHaveBeenCalledTimes(1)
  })

  it('ignores a gesture that does not actually move the roll', () => {
    render({ playheadX: 0, isPlaying: false, enabled: true })
    runFrames()

    // Wheeling at the left edge scrolls nothing, so no scroll event follows and
    // follow stays on rather than being switched off for nothing.
    act(() => {
      container.dispatchEvent(new Event('wheel'))
    })

    expect(onUserScroll).not.toHaveBeenCalled()
  })

  it('credits a scroll to the app once the input window has passed', () => {
    render({ playheadX: 5000, isPlaying: true, enabled: true })
    runFrames()

    act(() => {
      container.dispatchEvent(new Event('wheel'))
    })
    act(() => {
      vi.advanceTimersByTime(2000)
      container.dispatchEvent(new Event('scroll'))
    })

    expect(onUserScroll).not.toHaveBeenCalled()
  })

  it('reports a user scroll only once per gesture', () => {
    render({ playheadX: 5000, isPlaying: true, enabled: false })

    act(() => {
      container.dispatchEvent(new Event('wheel'))
      container.dispatchEvent(new Event('scroll'))
    })

    // Follow was already off, so there is nothing to release.
    expect(onUserScroll).not.toHaveBeenCalled()
  })

  it('forgets a stale gesture when follow is re-engaged', () => {
    const { rerender } = render({ playheadX: 5000, isPlaying: true, enabled: true })
    runFrames()

    // Wheeling at a hard edge latches intent but scrolls nothing.
    act(() => { container.dispatchEvent(new Event('wheel')) })
    rerender({ playheadX: 5000, isPlaying: true, enabled: false })
    rerender({ playheadX: 5000, isPlaying: true, enabled: true })

    // The catch-up that re-engaging asks for is ours, not that stale gesture's.
    act(() => { container.dispatchEvent(new Event('scroll')) })
    expect(onUserScroll).not.toHaveBeenCalled()
  })

  it('forgets a stale gesture when the roll is pressed to seek', () => {
    render({ playheadX: 5000, isPlaying: true, enabled: true })
    runFrames()

    act(() => {
      container.dispatchEvent(new Event('wheel'))
      // A press inside the content box is a seek, not a scroll.
      container.dispatchEvent(new PointerEvent('pointerdown', { clientY: 50 }))
      container.dispatchEvent(new Event('scroll'))
    })

    expect(onUserScroll).not.toHaveBeenCalled()
  })

  it('does nothing when the roll fits in the viewport', () => {
    Object.defineProperty(container, 'scrollWidth', { value: 500, configurable: true })
    render({ playheadX: 400, isPlaying: true, enabled: true })
    runFrames()

    expect(container.scrollLeft).toBe(0)
    expect(onUserScroll).not.toHaveBeenCalled()
  })

  it('stops the animation loop when unmounted', () => {
    const { unmount } = render({ playheadX: 5000, isPlaying: true, enabled: true })
    runFrames(3)

    unmount()
    const parked = container.scrollLeft
    runFrames(60)
    expect(container.scrollLeft).toBe(parked)
  })

  it('stops touching the scroll as soon as follow is switched off', () => {
    const { rerender } = render({ playheadX: 5000, isPlaying: true, enabled: true })
    runFrames()

    // Once the user takes over, their scroll position must survive the next
    // frame -- otherwise scrolling feels locked.
    rerender({ playheadX: 5000, isPlaying: true, enabled: false })
    container.scrollLeft = 100
    runFrames(60)

    expect(container.scrollLeft).toBe(100)
  })
})
