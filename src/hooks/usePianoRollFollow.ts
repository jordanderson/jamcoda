import { useCallback, useEffect, useRef } from 'react'
import {
  easeScrollLeft,
  followScrollTarget,
  isFollowSettled
} from '@/components/midi/pianoRollFollow'

/**
 * How long after a scroll-producing input a `scroll` event is still credited
 * to the user.
 *
 * Generous on purpose. A wheel reports first and its scroll lands a frame or
 * more later, and a long recording renders tens of thousands of rects. A
 * tight window would strand real gestures. Erring long is safe because the
 * paths that could be misattributed clear the latch outright.
 */
const USER_SCROLL_WINDOW_MS = 1200

/** Keys that scroll a container when it or one of its descendants has focus. */
const SCROLL_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' '
])

interface UsePianoRollFollowOptions {
  /** The horizontally scrolling element that holds the roll. */
  container: HTMLElement | null
  /** Playhead position in content pixels. */
  playheadX: number
  /** Whether audio is advancing; a settled follower keeps animating if so. */
  isPlaying: boolean
  /** Whether follow mode is on. */
  enabled: boolean
  /** Temporarily hand the scroll back, e.g. while an annotation is dragged. */
  suspended?: boolean
  /** Called once when the user scrolls the container themselves. */
  onUserScroll: () => void
}

/**
 * Drives "follow playback" scrolling, and hands control back the moment the
 * user scrolls.
 *
 * Following runs on its own animation frame loop reading the latest inputs
 * from a ref, so it behaves the same however often React re-renders and a
 * paused seek still animates. It parks once the viewport settles.
 *
 * A user scroll needs two signals: a scroll-producing input (wheel, touch
 * drag, scroll key, scrollbar grab) *and* a `scroll` event confirming it
 * moved the container. Requiring both keeps our own eased writes from
 * looking like the user, and keeps a gesture that moves nothing (already at
 * the edge) from switching follow off for no reason.
 */
export function usePianoRollFollow({
  container,
  playheadX,
  isPlaying,
  enabled,
  suspended = false,
  onUserScroll
}: UsePianoRollFollowOptions) {
  const frameRef = useRef<number | null>(null)
  const userInputAtRef = useRef(0)
  const onUserScrollRef = useRef(onUserScroll)
  const stateRef = useRef({ playheadX, isPlaying, enabled, suspended })

  useEffect(() => {
    onUserScrollRef.current = onUserScroll
  }, [onUserScroll])

  const cancelFrame = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [])

  /** Ease one step toward the anchor, and keep the loop alive if more remains. */
  const runFollowFrame = useCallback(() => {
    frameRef.current = null

    const state = stateRef.current
    if (!container || !state.enabled || state.suspended) return

    const target = followScrollTarget(state.playheadX, {
      clientWidth: container.clientWidth,
      scrollWidth: container.scrollWidth
    })
    // Nothing to scroll: the roll fits in the viewport.
    if (target === null) return

    const current = container.scrollLeft
    const next = easeScrollLeft(current, target)
    if (next !== current) {
      container.scrollLeft = next
    }

    // While playing the target keeps moving, so stay alive past catching up.
    if (state.isPlaying || !isFollowSettled(container.scrollLeft, target)) {
      frameRef.current = requestAnimationFrame(runFollowFrame)
    }
  }, [container])

  // Publish the latest inputs and wake the loop. Waking on every change is
  // what animates a paused seek, which has no playback frames to ride on.
  useEffect(() => {
    const wasEnabled = stateRef.current.enabled
    stateRef.current = { playheadX, isPlaying, enabled, suspended }

    // Re-engaging is a request to be scrolled, so an earlier gesture must
    // not stay latched and claim the catch-up as the user's.
    if (enabled && !wasEnabled) {
      userInputAtRef.current = 0
    }

    if (!container || !enabled || suspended) {
      cancelFrame()
      return
    }
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(runFollowFrame)
    }
  }, [container, playheadX, isPlaying, enabled, suspended, cancelFrame, runFollowFrame])

  useEffect(() => cancelFrame, [cancelFrame])

  // Driven off refs so toggling follow does not rebuild the listeners.
  useEffect(() => {
    if (!container) return

    const noteUserInput = () => {
      userInputAtRef.current = Date.now()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) noteUserInput()
    }

    // Only a press on the scrollbar is a scroll. A press inside the roll is
    // a seek, so it clears any stale latch that would steal the seek's own
    // scroll.
    const handlePointerDown = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect()
      const contentBottom = rect.top + container.clientTop + container.clientHeight
      if (event.clientY >= contentBottom) {
        noteUserInput()
        return
      }
      userInputAtRef.current = 0
    }

    const handleScroll = () => {
      if (!stateRef.current.enabled) return
      if (Date.now() - userInputAtRef.current > USER_SCROLL_WINDOW_MS) return
      userInputAtRef.current = 0
      cancelFrame()
      onUserScrollRef.current()
    }

    container.addEventListener('wheel', noteUserInput, { passive: true })
    container.addEventListener('touchmove', noteUserInput, { passive: true })
    container.addEventListener('keydown', handleKeyDown)
    container.addEventListener('pointerdown', handlePointerDown)
    container.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      container.removeEventListener('wheel', noteUserInput)
      container.removeEventListener('touchmove', noteUserInput)
      container.removeEventListener('keydown', handleKeyDown)
      container.removeEventListener('pointerdown', handlePointerDown)
      container.removeEventListener('scroll', handleScroll)
    }
  }, [container, cancelFrame])
}
