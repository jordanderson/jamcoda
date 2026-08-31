import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor, type RenderHookResult } from '@testing-library/react'
import type { NoteSequence } from '@core/midi/noteSequence'

/**
 * Starting playback is asynchronous: the sampler resumes the AudioContext and
 * loads samples before any note is scheduled. These tests hold that window open
 * so a stop, pause or seek can land inside it.
 */

const sequence: NoteSequence = {
  notes: [{ pitch: 60, velocity: 80, startTime: 0, endTime: 10 }],
  totalTime: 60
}

/** Resolves the pending `preload`, held open until a test releases it. */
let releasePreload: (() => void) | null = null
const samplerCalls = { start: 0, stop: 0 }

vi.mock('@/audio/pianoSampler', () => ({
  PianoSampler: class {
    async resumeContext() {}

    preload() {
      return new Promise<void>((resolve) => {
        releasePreload = resolve
      })
    }

    start() {
      samplerCalls.start++
      return 0
    }

    stop() {
      samplerCalls.stop++
    }

    now() {
      return 0
    }

    dispose() {}
  }
}))

vi.mock('@core/midi/noteSequence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/midi/noteSequence')>()),
  parseNoteSequence: () => sequence
}))

const { useMidiPlayer } = await import('./useMidiPlayer')

type Player = RenderHookResult<ReturnType<typeof useMidiPlayer>, unknown>

async function loadedPlayer(): Promise<Player> {
  const hook = renderHook(() => useMidiPlayer())
  await act(async () => {
    await hook.result.current.loadMidi(new Blob([new Uint8Array([0])]))
  })
  return hook
}

/**
 * Run `action` and settle until the sampler is waiting on samples. Asserting
 * the preload is really pending matters: without it the interruption tests
 * would pass vacuously, never reaching the window they exercise.
 */
async function startAndSuspend(action: () => void) {
  releasePreload = null
  await act(async () => { action() })
  expect(releasePreload, 'expected playback to be waiting on samples').not.toBeNull()
}

/** Let the held preload finish and the resulting state land. */
async function finishLoading() {
  await act(async () => {
    releasePreload?.()
  })
}

describe('useMidiPlayer', () => {
  beforeEach(() => {
    releasePreload = null
    samplerCalls.start = 0
    samplerCalls.stop = 0
  })

  it('exposes the loaded sequence and its duration', async () => {
    const { result } = await loadedPlayer()

    expect(result.current.isLoaded).toBe(true)
    expect(result.current.sequence).toBe(sequence)
    expect(result.current.duration).toBe(60)
    expect(result.current.currentTime).toBe(0)
  })

  it('plays normally when nothing interrupts the load', async () => {
    const { result } = await loadedPlayer()

    await startAndSuspend(() => { void result.current.play() })
    expect(samplerCalls.start).toBe(0)

    await finishLoading()

    await waitFor(() => expect(result.current.isPlaying).toBe(true))
    expect(samplerCalls.start).toBe(1)
  })

  it('does not start playing after a stop issued while samples were loading', async () => {
    const { result } = await loadedPlayer()

    await startAndSuspend(() => { void result.current.play() })
    act(() => { result.current.stop() })
    await finishLoading()

    expect(samplerCalls.start).toBe(0)
    expect(result.current.isPlaying).toBe(false)
    expect(result.current.currentTime).toBe(0)
  })

  it('does not start playing after a pause issued while samples were loading', async () => {
    const { result } = await loadedPlayer()

    await startAndSuspend(() => { void result.current.play() })
    act(() => { result.current.pause() })
    await finishLoading()

    expect(samplerCalls.start).toBe(0)
    expect(result.current.isPlaying).toBe(false)
  })

  it('can play again after being stopped mid-load', async () => {
    const { result } = await loadedPlayer()

    await startAndSuspend(() => { void result.current.play() })
    act(() => { result.current.stop() })
    await finishLoading()
    expect(result.current.isPlaying).toBe(false)

    await startAndSuspend(() => { void result.current.play() })
    await finishLoading()

    await waitFor(() => expect(result.current.isPlaying).toBe(true))
    expect(samplerCalls.start).toBe(1)
  })

  it('keeps playing when a seek lands while samples are loading', async () => {
    const { result } = await loadedPlayer()

    await startAndSuspend(() => { void result.current.play() })
    // The seek supersedes the pending start rather than cancelling playback.
    await startAndSuspend(() => { void result.current.seekTo(30) })
    await finishLoading()

    await waitFor(() => expect(result.current.isPlaying).toBe(true))
    expect(result.current.currentTime).toBe(30)
    expect(samplerCalls.start).toBe(1)
  })

  it('seeking while stopped moves the playhead without starting audio', async () => {
    const { result } = await loadedPlayer()

    await act(async () => {
      await result.current.seekTo(42)
    })

    expect(result.current.currentTime).toBe(42)
    expect(result.current.isPlaying).toBe(false)
    expect(samplerCalls.start).toBe(0)
  })

  it('clamps a seek to the sequence', async () => {
    const { result } = await loadedPlayer()

    await act(async () => { await result.current.seekTo(-5) })
    expect(result.current.currentTime).toBe(0)

    await act(async () => { await result.current.seekTo(9999) })
    expect(result.current.currentTime).toBe(60)
  })

  it('ignores playback commands before a file is loaded', async () => {
    const { result } = renderHook(() => useMidiPlayer())

    await act(async () => {
      await result.current.play()
      await result.current.seekTo(10)
    })

    expect(samplerCalls.start).toBe(0)
    expect(result.current.isPlaying).toBe(false)
  })
})
