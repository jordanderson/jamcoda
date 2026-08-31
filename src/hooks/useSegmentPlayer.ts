import { useMemo, useState } from 'react'
import { useMidiPlayer } from '@/hooks/useMidiPlayer'

/**
 * Playback scoped to one time range of the loaded file.
 *
 * SongsPage and PredictionReviewPage both needed "play just this segment, with
 * a scrubber relative to its own start". They had independent copies:
 * `segmentCurrentTime` and `segmentElapsed` were byte-identical, while the
 * seek handlers had quietly diverged -- one parked the playhead at the segment
 * end after stopping and surfaced errors in the UI, the other did neither.
 * This is the single implementation, taking the more complete behaviour of
 * the two.
 */

export interface SegmentBounds {
  start: number
  end: number
  duration: number
}

export function toSegmentBounds(start: number, end: number): SegmentBounds | null {
  if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) {
    return null
  }
  return { start, end, duration: end - start }
}

export interface UseSegmentPlayerResult extends ReturnType<typeof useMidiPlayer> {
  /** Playhead clamped to the segment, following the scrubber while dragging. */
  segmentCurrentTime: number
  /** Seconds elapsed since the segment's start. */
  segmentElapsed: number
  isScrubbing: boolean
  /**
   * Range-input handlers. A pointer drag calls start -> change* -> commit and
   * only seeks once, on commit; a keyboard change arrives without `start` and
   * seeks immediately.
   */
  onScrubStart: () => void
  onScrubChange: (time: number) => void
  onScrubCommit: () => void
  /** Play the segment from its start. */
  playFromStart: () => Promise<void>
  /** Toggle play/pause within the segment, resuming where it left off. */
  togglePlayback: () => Promise<void>
  seekWithinSegment: (time: number) => Promise<void>
  restart: () => Promise<void>
  playbackError: string | null
  clearPlaybackError: () => void
}

export function useSegmentPlayer(bounds: SegmentBounds | null): UseSegmentPlayerResult {
  const player = useMidiPlayer()
  const { currentTime, isLoaded, isPlaying, playSegment, seekTo, stop } = player

  const [isScrubbing, setIsScrubbing] = useState(false)
  const [scrubValue, setScrubValue] = useState<number | null>(null)
  const [playbackError, setPlaybackError] = useState<string | null>(null)

  const segmentCurrentTime = useMemo(() => {
    if (!bounds) return 0
    const source = isScrubbing && scrubValue !== null ? scrubValue : currentTime
    return Math.min(bounds.end, Math.max(bounds.start, source))
  }, [bounds, currentTime, isScrubbing, scrubValue])

  const segmentElapsed = bounds ? Math.max(0, segmentCurrentTime - bounds.start) : 0

  const guard = async (action: () => Promise<void>, fallback: string) => {
    try {
      await action()
      setPlaybackError(null)
    } catch (err) {
      setPlaybackError(err instanceof Error ? err.message : fallback)
    }
  }

  const seekWithinSegment = async (time: number) => {
    if (!bounds || !isLoaded) return
    const target = Math.min(bounds.end, Math.max(bounds.start, time))

    await guard(async () => {
      if (!isPlaying) {
        await seekTo(target)
        return
      }
      // Scrubbing to the very end stops rather than starting a zero-length
      // segment, and leaves the playhead parked at the end.
      if (target >= bounds.end) {
        stop()
        await seekTo(bounds.end)
        return
      }
      await playSegment(target, bounds.end)
    }, 'Failed to seek within segment')
  }

  const playFromStart = async () => {
    if (!bounds || !isLoaded) return
    await guard(() => playSegment(bounds.start, bounds.end), 'Failed to play segment')
  }

  const togglePlayback = async () => {
    if (!bounds || !isLoaded) return

    if (isPlaying) {
      stop()
      return
    }
    // Resume where the playhead sits, restarting if it reached the end.
    const from = segmentCurrentTime >= bounds.end ? bounds.start : segmentCurrentTime
    await guard(() => playSegment(from, bounds.end), 'Failed to play segment')
  }

  const restart = async () => {
    if (!bounds || !isLoaded) return
    await guard(() => seekTo(bounds.start), 'Failed to restart segment')
  }

  return {
    ...player,
    segmentCurrentTime,
    segmentElapsed,
    isScrubbing,
    onScrubStart: () => setIsScrubbing(true),
    onScrubChange: (time: number) => {
      setScrubValue(time)
      // Keyboard changes arrive without a preceding pointer-down, so they take
      // effect immediately rather than waiting for a commit that never comes.
      if (!isScrubbing) {
        void seekWithinSegment(time)
      }
    },
    onScrubCommit: () => {
      const target = scrubValue
      setIsScrubbing(false)
      setScrubValue(null)
      if (target !== null) {
        void seekWithinSegment(target)
      }
    },
    playFromStart,
    togglePlayback,
    seekWithinSegment,
    restart,
    playbackError,
    clearPlaybackError: () => setPlaybackError(null)
  }
}
