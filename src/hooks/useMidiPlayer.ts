import { useCallback, useEffect, useRef, useState } from 'react'
import {
  parseNoteSequence,
  sequenceFrom,
  sliceSequence,
  type NoteSequence
} from '@core/midi/noteSequence'
import { PianoSampler } from '@/audio/pianoSampler'

/** Reactive playback state exposed by `useMidiPlayer`. */
interface PlayerState {
  isPlaying: boolean
  isLoaded: boolean
  error: string | null
  currentTime: number
  duration: number
}

/** Public API returned by `useMidiPlayer`. */
interface UseMidiPlayerResult extends PlayerState {
  play: () => Promise<void>
  playSegment: (startTime: number, endTime: number) => Promise<void>
  pause: () => void
  stop: () => void
  loadMidi: (blob: Blob) => Promise<void>
  seekTo: (time: number) => Promise<void>
  sequence: NoteSequence | null
}

/** What the animation frame loop needs to derive the playhead. */
interface ActivePlayback {
  /** AudioContext timestamp the sequence was scheduled against. */
  origin: number
  /** Position in the original sequence that `origin` corresponds to. */
  offset: number
  /** Position in the original sequence at which playback should end. */
  stopAt: number
  /** Full-track playback rewinds on completion; segments hold at the end. */
  rewindOnEnd: boolean
}

/**
 * Local MIDI playback controller.
 *
 * Built on `PianoSampler` (Web Audio) since dropping `@magenta/music`. All
 * notes sound as grand piano, which is the only instrument the sampler loads
 * -- previously this was enforced by rewriting each note's program number.
 *
 * Supports full-track play, segment play, pause/resume, stop, and seek.
 */
export function useMidiPlayer(): UseMidiPlayerResult {
  const samplerRef = useRef<PianoSampler | null>(null)
  const sequenceRef = useRef<NoteSequence | null>(null)
  const playbackRef = useRef<ActivePlayback | null>(null)
  const frameRef = useRef<number | null>(null)
  /** Where a resume should pick up, when paused or after a seek. */
  const resumeFromRef = useRef<number>(0)
  /**
   * Mirrors `state.isLoaded` for the guards below.
   *
   * A caller typically does `await loadMidi(blob)` then immediately
   * `playSegment(...)` inside one handler. Reading `state.isLoaded` there sees
   * the value captured when the handler's closure was created -- still false --
   * so the play call silently no-ops and the first click does nothing.
   */
  const isLoadedRef = useRef(false)

  const [state, setState] = useState<PlayerState>({
    isPlaying: false,
    isLoaded: false,
    error: null,
    currentTime: 0,
    duration: 0
  })

  const getSampler = useCallback((): PianoSampler => {
    if (!samplerRef.current) {
      samplerRef.current = new PianoSampler()
    }
    return samplerRef.current
  }, [])

  const cancelFrame = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [])

  /** Halt audio and the playhead loop without touching reactive state. */
  const haltPlayback = useCallback(() => {
    cancelFrame()
    playbackRef.current = null
    samplerRef.current?.stop()
  }, [cancelFrame])

  useEffect(() => {
    return () => {
      cancelFrame()
      samplerRef.current?.dispose()
      samplerRef.current = null
    }
  }, [cancelFrame])

  /**
   * Drive `currentTime` from the AudioContext clock, which is the same clock
   * the notes are scheduled against, and end playback at `stopAt`.
   */
  const runPlayhead = useCallback(() => {
    const tick = () => {
      const playback = playbackRef.current
      const sampler = samplerRef.current
      if (!playback || !sampler) return

      const elapsed = Math.max(0, sampler.now() - playback.origin)
      const position = playback.offset + elapsed

      if (position >= playback.stopAt) {
        const { rewindOnEnd, stopAt } = playback
        haltPlayback()
        resumeFromRef.current = rewindOnEnd ? 0 : stopAt
        setState((prev) => ({
          ...prev,
          isPlaying: false,
          currentTime: rewindOnEnd ? 0 : stopAt
        }))
        return
      }

      setState((prev) => (prev.currentTime === position ? prev : { ...prev, currentTime: position }))
      frameRef.current = requestAnimationFrame(tick)
    }

    cancelFrame()
    frameRef.current = requestAnimationFrame(tick)
  }, [cancelFrame, haltPlayback])

  /** Schedule `[fromTime, stopAt)` of the loaded sequence and start the playhead. */
  const beginPlayback = useCallback(async (
    fromTime: number,
    stopAt: number,
    rewindOnEnd: boolean
  ) => {
    const sequence = sequenceRef.current
    if (!sequence) return

    const sampler = getSampler()
    haltPlayback()

    const slice = rewindOnEnd
      ? sequenceFrom(sequence, fromTime)
      : sliceSequence(sequence, fromTime, stopAt)

    await sampler.resumeContext()
    await sampler.preload(slice)

    // A stop/seek may have landed while samples were loading.
    if (sequenceRef.current !== sequence) return

    const origin = sampler.start(slice)
    playbackRef.current = { origin, offset: fromTime, stopAt, rewindOnEnd }

    setState((prev) => ({ ...prev, isPlaying: true, error: null, currentTime: fromTime }))
    runPlayhead()
  }, [getSampler, haltPlayback, runPlayhead])

  const withPlaybackError = useCallback((fallback: string) => (err: unknown) => {
    const message = err instanceof Error ? err.message : fallback
    haltPlayback()
    setState((prev) => ({ ...prev, error: message, isPlaying: false }))
    console.error(fallback, err)
  }, [haltPlayback])

  const loadMidi = useCallback(async (blob: Blob) => {
    try {
      haltPlayback()
      isLoadedRef.current = false
      setState((prev) => ({ ...prev, isLoaded: false, error: null }))

      const arrayBuffer = await blob.arrayBuffer()
      const sequence = parseNoteSequence(new Uint8Array(arrayBuffer))

      sequenceRef.current = sequence
      resumeFromRef.current = 0
      isLoadedRef.current = true

      setState((prev) => ({
        ...prev,
        isLoaded: true,
        error: null,
        duration: sequence.totalTime,
        currentTime: 0,
        isPlaying: false
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load MIDI file'
      isLoadedRef.current = false
      setState((prev) => ({ ...prev, error: message, isLoaded: false }))
      console.error('Error loading MIDI:', err)
    }
  }, [haltPlayback])

  const play = useCallback(async () => {
    const sequence = sequenceRef.current
    if (!sequence || !isLoadedRef.current) return

    const from = resumeFromRef.current
    // Resuming at (or past) the end restarts from the top.
    const startAt = from >= sequence.totalTime ? 0 : from

    try {
      await beginPlayback(startAt, sequence.totalTime, true)
    } catch (err) {
      withPlaybackError('Playback failed')(err)
    }
  }, [beginPlayback, withPlaybackError])

  const playSegment = useCallback(async (startTime: number, endTime: number) => {
    const sequence = sequenceRef.current
    if (!sequence || !isLoadedRef.current) return
    if (!(Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime)) return

    try {
      await beginPlayback(startTime, endTime, false)
    } catch (err) {
      withPlaybackError('Segment playback failed')(err)
    }
  }, [beginPlayback, withPlaybackError])

  const pause = useCallback(() => {
    if (!playbackRef.current) return

    const playback = playbackRef.current
    const sampler = samplerRef.current
    const position = sampler
      ? playback.offset + Math.max(0, sampler.now() - playback.origin)
      : playback.offset

    haltPlayback()
    resumeFromRef.current = position
    setState((prev) => ({ ...prev, isPlaying: false, currentTime: position }))
  }, [haltPlayback])

  const stop = useCallback(() => {
    haltPlayback()
    resumeFromRef.current = 0
    setState((prev) => ({ ...prev, isPlaying: false, currentTime: 0 }))
  }, [haltPlayback])

  const seekTo = useCallback(async (time: number) => {
    const sequence = sequenceRef.current
    if (!sequence || !isLoadedRef.current) return

    const wasPlaying = playbackRef.current !== null
    const target = Math.min(Math.max(0, time), sequence.totalTime)

    haltPlayback()
    resumeFromRef.current = target
    setState((prev) => ({ ...prev, currentTime: target, isPlaying: false }))

    if (!wasPlaying) return

    try {
      await beginPlayback(target, sequence.totalTime, true)
    } catch (err) {
      withPlaybackError('Seek failed')(err)
    }
  }, [beginPlayback, haltPlayback, withPlaybackError])

  return {
    ...state,
    play,
    playSegment,
    pause,
    stop,
    loadMidi,
    seekTo,
    sequence: sequenceRef.current
  }
}
