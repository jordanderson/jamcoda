import { describe, expect, it } from 'vitest'
import type { MidiData, MidiEvent } from 'midi-file'
import { buildTempoMap, ticksToSeconds } from './tempoMap'

const JMX_TICKS_PER_BEAT = 458
const JMX_MICROSECONDS_PER_BEAT = 458_000

function midiWithTempos(
  tempos: Array<{ tick: number; microsecondsPerBeat: number }>,
  ticksPerBeat = JMX_TICKS_PER_BEAT
): MidiData {
  const track: MidiEvent[] = []
  let previous = 0
  for (const tempo of [...tempos].sort((a, b) => a.tick - b.tick)) {
    track.push({
      deltaTime: tempo.tick - previous,
      type: 'setTempo',
      microsecondsPerBeat: tempo.microsecondsPerBeat,
      meta: true
    } as MidiEvent)
    previous = tempo.tick
  }
  track.push({ deltaTime: 0, type: 'endOfTrack', meta: true } as MidiEvent)

  return { header: { format: 0, numTracks: 1, ticksPerBeat }, tracks: [track] }
}

describe('buildTempoMap', () => {
  it('puts a file with no tempo event on the SMF default of 120 BPM', () => {
    const map = buildTempoMap(midiWithTempos([]))

    expect(map.changes).toEqual([{ tick: 0, microsecondsPerBeat: 500_000, seconds: 0 }])
    // 500000us / 458 ticks per beat = 1091.7us per tick.
    expect(ticksToSeconds(map, 458)).toBeCloseTo(0.5, 9)
  })

  it('reads the JMX grid as one millisecond per tick', () => {
    const map = buildTempoMap(midiWithTempos([
      { tick: 0, microsecondsPerBeat: JMX_MICROSECONDS_PER_BEAT }
    ]))

    expect(ticksToSeconds(map, 1000)).toBeCloseTo(1, 9)
    expect(ticksToSeconds(map, 5_949_112)).toBeCloseTo(5949.112, 6)
  })

  /**
   * The case the old byte-rewriting `normalizeJamcorderTempoMap` existed for.
   * Jamcorder declares its tempo partway into the track; without mirroring it
   * at tick 0 the opening stretch is timed at the 120 BPM default and every
   * note before the declaration lands 9% late.
   */
  it('mirrors a late Jamcorder tempo back to tick 0', () => {
    const map = buildTempoMap(midiWithTempos([
      { tick: 723_401, microsecondsPerBeat: JMX_MICROSECONDS_PER_BEAT },
      { tick: 1_642_742, microsecondsPerBeat: JMX_MICROSECONDS_PER_BEAT }
    ]))

    expect(map.changes[0]).toEqual({
      tick: 0,
      microsecondsPerBeat: JMX_MICROSECONDS_PER_BEAT,
      seconds: 0
    })
    expect(ticksToSeconds(map, 723_401)).toBeCloseTo(723.401, 6)
  })

  it('does not mirror a late tempo that is not on the one-millisecond grid', () => {
    const map = buildTempoMap(midiWithTempos([{ tick: 1000, microsecondsPerBeat: 600_000 }]))

    // Falls back to the spec default for the opening stretch instead.
    expect(map.changes[0].microsecondsPerBeat).toBe(500_000)
    expect(map.changes[1]).toEqual({
      tick: 1000,
      microsecondsPerBeat: 600_000,
      seconds: (1000 * 500_000) / (JMX_TICKS_PER_BEAT * 1e6)
    })
  })

  it('does not mirror when the file changes tempo partway', () => {
    const map = buildTempoMap(midiWithTempos([
      { tick: 1000, microsecondsPerBeat: JMX_MICROSECONDS_PER_BEAT },
      { tick: 2000, microsecondsPerBeat: 300_000 }
    ]))

    expect(map.changes[0].microsecondsPerBeat).toBe(500_000)
  })

  it('accumulates across a real tempo change', () => {
    const map = buildTempoMap(midiWithTempos([
      { tick: 0, microsecondsPerBeat: 500_000 },
      { tick: 458, microsecondsPerBeat: 250_000 }
    ]))

    expect(ticksToSeconds(map, 458)).toBeCloseTo(0.5, 9)
    // Second beat runs at half the length of the first.
    expect(ticksToSeconds(map, 916)).toBeCloseTo(0.75, 9)
  })

  it('times an SMPTE-divided file by its frame rate, ignoring tempo', () => {
    const map = buildTempoMap({
      header: { format: 0, numTracks: 1, framesPerSecond: 25, ticksPerFrame: 40 },
      tracks: [[{ deltaTime: 0, type: 'endOfTrack', meta: true } as MidiEvent]]
    })

    expect(map.fixedSecondsPerTick).toBeCloseTo(1 / 1000, 12)
    expect(ticksToSeconds(map, 1000)).toBeCloseTo(1, 9)
  })

  it('is monotonic across many changes', () => {
    const map = buildTempoMap(midiWithTempos([
      { tick: 0, microsecondsPerBeat: 500_000 },
      { tick: 1000, microsecondsPerBeat: 250_000 },
      { tick: 2000, microsecondsPerBeat: 900_000 },
      { tick: 3000, microsecondsPerBeat: 100_000 }
    ]))

    let previous = -1
    for (let tick = 0; tick <= 4000; tick += 137) {
      const seconds = ticksToSeconds(map, tick)
      expect(seconds).toBeGreaterThan(previous)
      previous = seconds
    }
  })
})
