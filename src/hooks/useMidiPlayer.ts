import { useEffect, useRef, useState } from 'react'
import * as mm from '@magenta/music'
import { normalizeJamcorderTempoMap } from '../../lib/midiTempoNormalization'

const GRAND_PIANO_PROGRAM = 0
const GRAND_PIANO_INSTRUMENT = 0

/**
 * Rewrites all note programs to acoustic grand piano so playback is consistent
 * regardless of original MIDI instrument assignments.
 */
function forceGrandPianoSequence(sequence: mm.INoteSequence): mm.INoteSequence {
  const normalized = mm.sequences.clone(sequence)
  normalized.notes = (normalized.notes || []).map((note) => ({
    ...note,
    program: GRAND_PIANO_PROGRAM,
    instrument: GRAND_PIANO_INSTRUMENT,
    isDrum: false,
  }))
  return normalized
}

/** Reactive playback state exposed by `useMidiPlayer`. */
interface PlayerState {
  isPlaying: boolean
  isLoaded: boolean
  error: string | null
  currentTime: number
  duration: number
  activeNote: mm.NoteSequence.Note | null
}

/** Optional callback hooks fired during note playback lifecycle. */
interface PlayerCallbacks {
  onNotePlay?: (note: mm.NoteSequence.Note) => void
  onPlaybackStop?: () => void
  onTimeUpdate?: (time: number) => void
}

/** Public API returned by `useMidiPlayer`. */
interface UseMidiPlayerResult extends PlayerState {
  play: () => Promise<void>
  playSegment: (startTime: number, endTime: number) => Promise<void>
  pause: () => void
  stop: () => void
  loadMidi: (blob: Blob) => Promise<void>
  seekTo: (time: number) => Promise<void>
  sequence: mm.INoteSequence | null
  setCallbacks: (callbacks: PlayerCallbacks) => void
}

/**
 * Local MIDI playback controller built on Magenta `SoundFontPlayer`.
 *
 * Behavior notes:
 * - Normalizes Jamcorder tempo maps before parsing.
 * - Forces all tracks to grand piano.
 * - Supports full-track play, segment play, pause/resume, stop, and seek.
 * - Emits optional note/time callbacks for visualizers.
 */
export function useMidiPlayer(): UseMidiPlayerResult {
  const playerRef = useRef<mm.SoundFontPlayer | null>(null)
  const sequenceRef = useRef<mm.INoteSequence | null>(null)
  const callbacksRef = useRef<PlayerCallbacks>({})
  const isPausedRef = useRef<boolean>(false)
  const seekPositionRef = useRef<number>(0) // Track seek position for next play
  const timeOffsetRef = useRef<number>(0) // Track time offset for display
  const [state, setState] = useState<PlayerState>({
    isPlaying: false,
    isLoaded: false,
    error: null,
    currentTime: 0,
    duration: 0,
    activeNote: null,
  })

  // Initialize player once
  useEffect(() => {
    if (!playerRef.current) {
      playerRef.current = new mm.SoundFontPlayer(
        'https://storage.googleapis.com/magentadata/js/soundfonts/sgm_plus',
        undefined, undefined, undefined,
        {
          run: (note: mm.NoteSequence.Note) => {
            // Add time offset back to get actual position in original sequence
            const actualTime = (note.startTime ?? 0) + timeOffsetRef.current

            // Create a note with adjusted times for the visualizer
            // The visualizer needs note times that match the original sequence
            const adjustedNote = {
              ...note,
              startTime: actualTime,
              endTime: (note.endTime ?? 0) + timeOffsetRef.current
            } as mm.NoteSequence.Note

            setState(prev => ({
              ...prev,
              activeNote: adjustedNote,
              currentTime: actualTime
            }))
            callbacksRef.current.onNotePlay?.(adjustedNote)
            callbacksRef.current.onTimeUpdate?.(actualTime)
          },
          stop: () => {
            setState(prev => ({ ...prev, activeNote: null }))
            callbacksRef.current.onPlaybackStop?.()
          }
        }
      )
    }

    return () => {
      if (playerRef.current) {
        playerRef.current.stop()
      }
    }
  }, [])

  const setCallbacks = (callbacks: PlayerCallbacks) => {
    callbacksRef.current = callbacks
  }

  const loadMidi = async (blob: Blob) => {
    try {
      setState((prev) => ({ ...prev, isLoaded: false, error: null }))

      const arrayBuffer = await blob.arrayBuffer()
      const normalizedBytes = normalizeJamcorderTempoMap(new Uint8Array(arrayBuffer))
      const sequence = mm.midiToSequenceProto(normalizedBytes)
      const pianoSequence = forceGrandPianoSequence(sequence)

      sequenceRef.current = pianoSequence
      isPausedRef.current = false

      // Calculate duration
      const duration = sequence.totalTime || pianoSequence.totalTime || 0

      setState((prev) => ({
        ...prev,
        isLoaded: true,
        error: null,
        duration,
        currentTime: 0,
      }))
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load MIDI file'
      setState((prev) => ({
        ...prev,
        error: errorMessage,
        isLoaded: false,
      }))
      console.error('Error loading MIDI:', err)
    }
  }

  const play = async () => {
    if (!playerRef.current || !sequenceRef.current || !state.isLoaded) {
      return
    }

    try {
      setState((prev) => ({ ...prev, isPlaying: true, error: null }))

      if (isPausedRef.current) {
        await playerRef.current.resume()
        isPausedRef.current = false
        seekPositionRef.current = 0
        timeOffsetRef.current = 0
        setState((prev) => ({ ...prev, isPlaying: false, currentTime: 0, activeNote: null }))
        return
      }

      // If there's a seek position, start from there
      let sequenceToPlay = sequenceRef.current
      if (seekPositionRef.current > 0) {
        timeOffsetRef.current = seekPositionRef.current
        sequenceToPlay = mm.sequences.clone(sequenceRef.current)

        // Offset notes
        if (sequenceToPlay.notes) {
          sequenceToPlay.notes = sequenceToPlay.notes
            .map(note => ({
              ...note,
              startTime: (note.startTime ?? 0) - seekPositionRef.current,
              endTime: (note.endTime ?? 0) - seekPositionRef.current
            }))
            .filter(note => (note.endTime ?? 0) > 0)
        }

        // Offset control changes (sustain pedal, etc.)
        if (sequenceToPlay.controlChanges) {
          sequenceToPlay.controlChanges = sequenceToPlay.controlChanges
            .map(cc => ({
              ...cc,
              time: (cc.time ?? 0) - seekPositionRef.current
            }))
            .filter(cc => (cc.time ?? 0) >= 0)
        }
      } else {
        timeOffsetRef.current = 0
      }

      await playerRef.current.start(sequenceToPlay)

      // When playback completes
      isPausedRef.current = false
      seekPositionRef.current = 0
      timeOffsetRef.current = 0
      setState((prev) => ({ ...prev, isPlaying: false, currentTime: 0, activeNote: null }))
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Playback failed'
      setState((prev) => ({
        ...prev,
        error: errorMessage,
        isPlaying: false,
      }))
      isPausedRef.current = false
      console.error('Playback error:', err)
    }
  }

  const playSegment = async (startTime: number, endTime: number) => {
    if (!playerRef.current || !sequenceRef.current || !state.isLoaded) {
      return
    }

    if (!(Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime)) {
      return
    }

    try {
      playerRef.current.stop()
      isPausedRef.current = false

      const segmentDuration = endTime - startTime
      const segmentSequence = mm.sequences.clone(sequenceRef.current)

      segmentSequence.notes = (segmentSequence.notes || [])
        .filter(note => (note.endTime ?? 0) > startTime && (note.startTime ?? 0) < endTime)
        .map(note => ({
          ...note,
          startTime: Math.max(0, (note.startTime ?? 0) - startTime),
          endTime: Math.min(segmentDuration, (note.endTime ?? 0) - startTime)
        }))
        .filter(note => (note.endTime ?? 0) > 0)

      if (segmentSequence.controlChanges) {
        segmentSequence.controlChanges = segmentSequence.controlChanges
          .filter(cc => (cc.time ?? 0) >= startTime && (cc.time ?? 0) <= endTime)
          .map(cc => ({
            ...cc,
            time: Math.max(0, (cc.time ?? 0) - startTime)
          }))
      }

      timeOffsetRef.current = startTime
      seekPositionRef.current = 0

      setState((prev) => ({
        ...prev,
        isPlaying: true,
        error: null,
        currentTime: startTime,
        activeNote: null
      }))

      await playerRef.current.start(segmentSequence)

      timeOffsetRef.current = 0
      setState((prev) => ({
        ...prev,
        isPlaying: false,
        currentTime: endTime,
        activeNote: null
      }))
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Segment playback failed'
      setState((prev) => ({
        ...prev,
        error: errorMessage,
        isPlaying: false,
      }))
      console.error('Segment playback error:', err)
    }
  }

  const pause = () => {
    if (playerRef.current && state.isPlaying) {
      playerRef.current.pause()
      isPausedRef.current = true
      setState((prev) => ({ ...prev, isPlaying: false }))
    }
  }

  const stop = () => {
    if (playerRef.current) {
      playerRef.current.stop()
      isPausedRef.current = false
      seekPositionRef.current = 0
      timeOffsetRef.current = 0
      setState((prev) => ({ ...prev, isPlaying: false, currentTime: 0, activeNote: null }))
    }
  }

  const seekTo = async (time: number) => {
    if (!playerRef.current || !sequenceRef.current || !state.isLoaded) {
      return
    }

    const wasPlaying = state.isPlaying

    try {
      // Stop current playback if playing
      if (wasPlaying) {
        playerRef.current.stop()
        isPausedRef.current = false
      } else if (isPausedRef.current) {
        // Seeking from paused state should restart from target on next play().
        playerRef.current.stop()
        isPausedRef.current = false
      }

      // Update seek position and current time
      seekPositionRef.current = time
      setState((prev) => ({ ...prev, currentTime: time, activeNote: null }))

      // If was playing, continue playing from new position
      if (wasPlaying) {
        // Set time offset for callbacks
        timeOffsetRef.current = time

        // Create a new sequence with adjusted start times
        const offsetSequence = mm.sequences.clone(sequenceRef.current)

        // Offset notes
        offsetSequence.notes = offsetSequence.notes
          .map(note => ({
            ...note,
            startTime: (note.startTime ?? 0) - time,
            endTime: (note.endTime ?? 0) - time
          }))
          .filter(note => (note.endTime ?? 0) > 0)

        // Offset control changes (sustain pedal, etc.)
        if (offsetSequence.controlChanges) {
          offsetSequence.controlChanges = offsetSequence.controlChanges
            .map(cc => ({
              ...cc,
              time: (cc.time ?? 0) - time
            }))
            .filter(cc => (cc.time ?? 0) >= 0)
        }

        setState((prev) => ({ ...prev, isPlaying: true }))
        await playerRef.current.start(offsetSequence)

        // When playback completes
        seekPositionRef.current = 0
        timeOffsetRef.current = 0
        setState((prev) => ({ ...prev, isPlaying: false, currentTime: 0, activeNote: null }))
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Seek failed'
      setState((prev) => ({
        ...prev,
        error: errorMessage,
        isPlaying: false,
      }))
      console.error('Seek error:', err)
    }
  }

  return {
    ...state,
    play,
    playSegment,
    pause,
    stop,
    loadMidi,
    seekTo,
    sequence: sequenceRef.current,
    setCallbacks,
  }
}
