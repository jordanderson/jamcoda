import { describe, expect, it } from 'vitest'
import { writeMidi, type MidiData, type MidiEvent } from 'midi-file'
import { parseNoteSequence } from './noteSequence'

/**
 * Fixtures are synthesised here rather than read from `data/midi/`: the tests
 * must not depend on a recording, and a recording must never be written to.
 *
 * Times are given in ticks. With `ticksPerBeat` 458 and a Set Tempo of 458,000
 * microseconds per beat -- the JMX grid -- one tick is exactly one
 * millisecond, so a tick value reads directly as milliseconds.
 */
const JMX_TICKS_PER_BEAT = 458
const JMX_MICROSECONDS_PER_BEAT = 458_000

interface Step {
  tick: number
  event: Omit<MidiEvent, 'deltaTime'>
}

function buildMidi(steps: Step[], options?: { tempoTick?: number | null }): Uint8Array {
  const tempoTick = options?.tempoTick === undefined ? 0 : options.tempoTick
  const all: Step[] = [...steps]
  if (tempoTick !== null) {
    all.push({
      tick: tempoTick,
      event: { type: 'setTempo', microsecondsPerBeat: JMX_MICROSECONDS_PER_BEAT, meta: true } as never
    })
  }
  all.sort((a, b) => a.tick - b.tick)

  const track: MidiEvent[] = []
  let previous = 0
  for (const step of all) {
    track.push({ ...step.event, deltaTime: step.tick - previous } as MidiEvent)
    previous = step.tick
  }
  track.push({ deltaTime: 0, type: 'endOfTrack', meta: true } as MidiEvent)

  const data: MidiData = {
    header: { format: 0, numTracks: 1, ticksPerBeat: JMX_TICKS_PER_BEAT },
    tracks: [track]
  }
  return new Uint8Array(writeMidi(data))
}

const on = (tick: number, noteNumber: number, velocity = 64, channel = 0): Step =>
  ({ tick, event: { type: 'noteOn', noteNumber, velocity, channel } as never })

const off = (tick: number, noteNumber: number, channel = 0): Step =>
  ({ tick, event: { type: 'noteOff', noteNumber, velocity: 64, channel } as never })

const allNotesOff = (tick: number, channel = 0): Step =>
  ({ tick, event: { type: 'controller', controllerType: 123, value: 0, channel } as never })

describe('parseNoteSequence', () => {
  it('pairs a note on with its note off', () => {
    const seq = parseNoteSequence(buildMidi([on(1000, 60, 80), off(1500, 60)]))

    expect(seq.notes).toEqual([
      { pitch: 60, velocity: 80, startTime: 1, endTime: 1.5 }
    ])
    expect(seq.totalTime).toBe(1.5)
  })

  it('treats a note on of velocity zero as a note off', () => {
    const seq = parseNoteSequence(buildMidi([on(1000, 60, 80), on(1500, 60, 0)]))

    expect(seq.notes).toHaveLength(1)
    expect(seq.notes[0].endTime).toBe(1.5)
  })

  // The bug this decoder exists to fix.
  it('ends every sounding note at an All Notes Off', () => {
    const seq = parseNoteSequence(buildMidi([
      on(1000, 53), on(1000, 57),
      allNotesOff(1200)
    ]))

    expect(seq.notes).toEqual([
      { pitch: 53, velocity: 64, startTime: 1, endTime: 1.2 },
      { pitch: 57, velocity: 64, startTime: 1, endTime: 1.2 }
    ])
  })

  it('does not let a note orphaned by All Notes Off steal a later release', () => {
    // The Jamcorder shape: two notes ended by All Notes Off, then the same
    // pitch played properly later. Pairing that ignores the All Notes Off
    // hands the orphan the later note off and invents a 100s sustain.
    const seq = parseNoteSequence(buildMidi([
      on(1000, 53), allNotesOff(1050),
      on(100_000, 53), off(100_400, 53),
      on(200_000, 53), off(200_500, 53)
    ]))

    expect(seq.notes.map((note) => [note.startTime, note.endTime])).toEqual([
      [1, 1.05],
      [100, 100.4],
      [200, 200.5]
    ])
  })

  it('caps a note left sounding far ahead of the All Notes Off that collects it', () => {
    const seq = parseNoteSequence(buildMidi([on(1000, 127), allNotesOff(1_500_000)]))

    expect(seq.notes).toHaveLength(1)
    expect(seq.notes[0].endTime - seq.notes[0].startTime).toBe(30)
  })

  it('leaves a measured release alone however long it is', () => {
    const seq = parseNoteSequence(buildMidi([on(1000, 71), off(400_000, 71)]))

    expect(seq.notes[0].endTime - seq.notes[0].startTime).toBeCloseTo(399, 6)
  })

  it('drops a note whose terminator lands on its own tick', () => {
    const zeroByOff = parseNoteSequence(buildMidi([on(1000, 60), off(1000, 60)]))
    const zeroByCc = parseNoteSequence(buildMidi([on(1000, 60), allNotesOff(1000)]))

    expect(zeroByOff.notes).toEqual([])
    expect(zeroByCc.notes).toEqual([])
  })

  it('keeps the same pitch on two channels apart', () => {
    const seq = parseNoteSequence(buildMidi([
      on(1000, 60, 80, 0), on(1100, 60, 90, 1),
      off(1200, 60, 0), off(1900, 60, 1)
    ]))

    expect(seq.notes).toEqual([
      { pitch: 60, velocity: 80, startTime: 1, endTime: 1.2 },
      { pitch: 60, velocity: 90, startTime: 1.1, endTime: 1.9 }
    ])
  })

  it('only silences the channel the All Notes Off was sent on', () => {
    const seq = parseNoteSequence(buildMidi([
      on(1000, 60, 80, 0), on(1000, 62, 80, 1),
      allNotesOff(1200, 0),
      off(1800, 62, 1)
    ]))

    expect(seq.notes).toEqual([
      { pitch: 60, velocity: 80, startTime: 1, endTime: 1.2 },
      { pitch: 62, velocity: 80, startTime: 1, endTime: 1.8 }
    ])
  })

  it('reads a pitch struck twice before either release as two notes, oldest first', () => {
    const seq = parseNoteSequence(buildMidi([
      on(1000, 60, 70), on(1200, 60, 90),
      off(1400, 60), off(1900, 60)
    ]))

    expect(seq.notes.map((note) => [note.startTime, note.endTime])).toEqual([
      [1, 1.4],
      [1.2, 1.9]
    ])
  })

  it('drops a note nothing ever releases rather than running it to the end', () => {
    const seq = parseNoteSequence(buildMidi([
      on(1000, 60), on(2000, 62), off(2500, 62)
    ]))

    expect(seq.notes.map((note) => note.pitch)).toEqual([62])
  })

  it('returns an empty sequence for bytes that are not a MIDI file', () => {
    expect(parseNoteSequence(new Uint8Array([1, 2, 3, 4]))).toEqual({ notes: [], totalTime: 0 })
  })

  it('sorts by onset then pitch', () => {
    const seq = parseNoteSequence(buildMidi([
      on(2000, 60), off(2100, 60),
      on(1000, 67), off(1100, 67),
      on(1000, 62), off(1100, 62)
    ]))

    expect(seq.notes.map((note) => note.pitch)).toEqual([62, 67, 60])
  })
})
