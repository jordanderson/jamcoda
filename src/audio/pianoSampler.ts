import type { Note, NoteSequence, SustainPedalEvent } from '@core/midi/noteSequence'

/**
 * A minimal Web Audio sampler for the acoustic grand piano.
 *
 * This replaces `@magenta/music`'s `SoundFontPlayer`, which pulled in
 * TensorFlow.js, protobufjs and Tone.js -- roughly 40 MB of dependencies with
 * nine unfixable advisories -- to play back a single instrument.
 *
 * It deliberately fetches the *same* sample URLs Magenta used, so the existing
 * soundfont service-worker cache (see `public/soundfont-cache-sw.js`) keeps
 * serving already-downloaded audio with no re-download and no changes.
 *
 * Sample layout, from the soundfont's own `instrument.json`:
 *   {BASE}/p{pitch}_v{velocity}.mp3   pitch 21-108, velocity in VELOCITY_LAYERS
 *
 * Damper pedal (CC 64): the decoded sequence carries the pedal events, and a
 * key released while the pedal is down keeps ringing (the sample's own decay)
 * until the pedal lifts, at which point its release begins. Sequences with no
 * pedal events play exactly as before.
 */

const SOUNDFONT_BASE =
  'https://storage.googleapis.com/magentadata/js/soundfonts/sgm_plus/acoustic_grand_piano'

/** Velocity layers published by the sgm_plus grand piano. */
const VELOCITY_LAYERS = [15, 31, 47, 63, 79, 95, 111, 127]

const MIN_PITCH = 21
const MAX_PITCH = 108

/** Seconds of exponential tail after note-off, matching the soundfont spec. */
const RELEASE_SECONDS = 1.0

/** Lead-in before the first scheduled note, to cover decode/scheduling jitter. */
const SCHEDULE_LEAD_SECONDS = 0.12

/**
 * How far ahead of the playhead notes get scheduled, and how often to top up.
 *
 * Scheduling a whole recording at once does not work. A 39-minute file is
 * ~20,000 notes, and creating that many source+gain node pairs swamps the
 * audio thread badly enough that `AudioContext.currentTime` stops tracking
 * real time (measured at ~4% of wall clock). That stalls playback and the
 * playhead. Only a small window is scheduled at a time, topped up by a
 * timer -- the standard Web Audio look-ahead pattern.
 */
const SCHEDULE_AHEAD_SECONDS = 1.5
const SCHEDULER_INTERVAL_MS = 250

function nearestVelocityLayer(velocity: number): number {
  let best = VELOCITY_LAYERS[0]
  let bestDistance = Infinity
  for (const layer of VELOCITY_LAYERS) {
    const distance = Math.abs(layer - velocity)
    if (distance < bestDistance) {
      best = layer
      bestDistance = distance
    }
  }
  return best
}

function sampleKey(pitch: number, velocityLayer: number): string {
  return `p${pitch}_v${velocityLayer}`
}

interface ScheduledVoice {
  source: AudioBufferSourceNode
  gain: GainNode
}

/** A span where the damper pedal was held down. */
export interface PedalInterval {
  down: number
  /** When the pedal lifted; null when it was still down at the end of the file. */
  up: number | null
}

/**
 * Reduce CC 64 sustain events into down/up spans. Consecutive presses extend
 * one span; a release with no span open, or a zero-length press, is dropped.
 */
export function buildPedalIntervals(events: SustainPedalEvent[]): PedalInterval[] {
  const intervals: PedalInterval[] = []
  let open: PedalInterval | null = null

  for (const event of events) {
    if (event.on) {
      if (!open) open = { down: event.time, up: null }
    } else if (open) {
      if (event.time > open.down) {
        open.up = event.time
        intervals.push(open)
        open = null
      } else {
        open = null
      }
    }
  }

  if (open) intervals.push(open)
  return intervals
}

/**
 * The pedal span holding a note released at `endTime`, or null when the pedal
 * was up (the key's own release stands). A key lifted on the same instant the
 * pedal lifts is not sustained: the damper has already fallen.
 */
export function heldByPedal(intervals: PedalInterval[], endTime: number): PedalInterval | null {
  for (const interval of intervals) {
    if (interval.down > endTime) break
    if (interval.up === null || endTime < interval.up) return interval
  }
  return null
}

/**
 * Loads piano samples on demand and schedules note playback.
 *
 * One instance owns one AudioContext. Call `dispose()` to release it.
 */
export class PianoSampler {
  private context: AudioContext | null = null
  private output: GainNode | null = null
  private readonly buffers = new Map<string, AudioBuffer>()
  private readonly pending = new Map<string, Promise<AudioBuffer | null>>()
  private voices: ScheduledVoice[] = []

  /** Notes of the sequence being played, ordered by start time. */
  private queue: Note[] = []
  /** Index of the first note in `queue` not yet handed to the audio thread. */
  private queueCursor = 0
  /** AudioContext time that `note.startTime === 0` maps to. */
  private originTime = 0
  private schedulerTimer: ReturnType<typeof setInterval> | null = null
  /** Damper pedal spans of the sequence being played, used to defer releases. */
  private pedalIntervals: PedalInterval[] = []
  /** `sequence.totalTime`, in the same seconds the notes are timed in. */
  private sequenceTotalTime = 0

  /** Create the AudioContext lazily -- browsers require a user gesture. */
  private ensureContext(): AudioContext {
    if (!this.context) {
      const Ctor: typeof AudioContext =
        window.AudioContext
        || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.context = new Ctor()
      this.output = this.context.createGain()
      this.output.gain.value = 1
      this.output.connect(this.context.destination)
    }
    return this.context
  }

  /** Resume a context suspended by browser autoplay policy. */
  async resumeContext(): Promise<void> {
    const context = this.ensureContext()
    if (context.state === 'suspended') {
      await context.resume()
    }
  }

  private async loadSample(pitch: number, velocityLayer: number): Promise<AudioBuffer | null> {
    const key = sampleKey(pitch, velocityLayer)

    const cached = this.buffers.get(key)
    if (cached) return cached

    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight

    const context = this.ensureContext()
    const request = (async () => {
      try {
        const response = await fetch(`${SOUNDFONT_BASE}/${key}.mp3`)
        if (!response.ok) return null
        const buffer = await context.decodeAudioData(await response.arrayBuffer())
        this.buffers.set(key, buffer)
        return buffer
      } catch {
        // A missing or undecodable sample silences one note rather than
        // failing the whole playback.
        return null
      } finally {
        this.pending.delete(key)
      }
    })()

    this.pending.set(key, request)
    return request
  }

  /**
   * Fetch every sample a sequence needs, so playback starts without gaps.
   * Samples already in the service-worker cache resolve immediately.
   */
  async preload(sequence: NoteSequence): Promise<void> {
    this.ensureContext()

    const required = new Set<string>()
    const requests: Array<Promise<unknown>> = []

    for (const note of sequence.notes) {
      if (note.pitch < MIN_PITCH || note.pitch > MAX_PITCH) continue
      const layer = nearestVelocityLayer(note.velocity)
      const key = sampleKey(note.pitch, layer)
      if (required.has(key)) continue
      required.add(key)
      requests.push(this.loadSample(note.pitch, layer))
    }

    await Promise.all(requests)
  }

  private scheduleNote(note: Note, originTime: number): void {
    const context = this.context
    const output = this.output
    if (!context || !output) return
    if (note.pitch < MIN_PITCH || note.pitch > MAX_PITCH) return

    const buffer = this.buffers.get(sampleKey(note.pitch, nearestVelocityLayer(note.velocity)))
    if (!buffer) return

    const startAt = originTime + note.startTime
    const heldUntil = originTime + note.endTime

    const source = context.createBufferSource()
    source.buffer = buffer

    const gain = context.createGain()
    gain.gain.setValueAtTime(1, startAt)

    // A key released under a held damper pedal keeps ringing (the sample
    // decays on its own) until the pedal lifts; the release then starts there.
    // Without a pedal -- or with the pedal up at release -- the release starts
    // when the key lifts, as before.
    const held = heldByPedal(this.pedalIntervals, note.endTime)
    const releaseAt = held
      ? (held.up !== null ? originTime + held.up : this.originTime + this.sequenceTotalTime)
      : heldUntil

    // Exponential-ish release once the damper falls, then a hard stop so the
    // voice is collectable.
    gain.gain.setTargetAtTime(0, releaseAt, RELEASE_SECONDS / 3)

    source.connect(gain)
    gain.connect(output)

    source.start(startAt)
    source.stop(releaseAt + RELEASE_SECONDS)

    const voice: ScheduledVoice = { source, gain }
    this.voices.push(voice)
    source.onended = () => {
      source.disconnect()
      gain.disconnect()
      this.voices = this.voices.filter((candidate) => candidate !== voice)
    }
  }

  /**
   * Begin playing a sequence. Returns the AudioContext timestamp that
   * `startTime === 0` maps to, so the caller can derive the playhead position
   * from the audio clock.
   *
   * Only the first look-ahead window is scheduled here; the rest follows on a
   * timer.
   */
  start(sequence: NoteSequence): number {
    const context = this.ensureContext()
    this.stop()

    this.queue = sequence.notes
    this.queueCursor = 0
    this.originTime = context.currentTime + SCHEDULE_LEAD_SECONDS
    this.pedalIntervals = buildPedalIntervals(sequence.sustainEvents ?? [])
    this.sequenceTotalTime = sequence.totalTime

    this.pumpScheduler()
    this.schedulerTimer = setInterval(() => this.pumpScheduler(), SCHEDULER_INTERVAL_MS)

    return this.originTime
  }

  /** Hand the audio thread any notes now falling inside the look-ahead window. */
  private pumpScheduler(): void {
    const context = this.context
    if (!context) return

    const horizon = context.currentTime + SCHEDULE_AHEAD_SECONDS

    while (this.queueCursor < this.queue.length) {
      const note = this.queue[this.queueCursor]
      if (this.originTime + note.startTime > horizon) break
      this.scheduleNote(note, this.originTime)
      this.queueCursor++
    }

    // Everything is scheduled; the timer has nothing left to do.
    if (this.queueCursor >= this.queue.length) {
      this.clearScheduler()
    }
  }

  private clearScheduler(): void {
    if (this.schedulerTimer !== null) {
      clearInterval(this.schedulerTimer)
      this.schedulerTimer = null
    }
  }

  /** Stop and discard every scheduled voice immediately. */
  stop(): void {
    this.clearScheduler()
    this.queue = []
    this.queueCursor = 0

    for (const voice of this.voices) {
      try {
        voice.source.onended = null
        voice.source.stop()
      } catch {
        // Already stopped, or never started; nothing to clean up.
      }
      voice.source.disconnect()
      voice.gain.disconnect()
    }
    this.voices = []
  }

  /** Current AudioContext clock, used to track playback position. */
  now(): number {
    return this.context?.currentTime ?? 0
  }

  async suspend(): Promise<void> {
    if (this.context && this.context.state === 'running') {
      await this.context.suspend()
    }
  }

  dispose(): void {
    this.stop()
    this.output?.disconnect()
    void this.context?.close()
    this.context = null
    this.output = null
    this.buffers.clear()
  }
}
