import { describe, expect, it } from 'vitest'
import type { SustainPedalEvent } from '@core/midi/noteSequence'
import { buildPedalIntervals, heldByPedal } from './pianoSampler'

const press = (time: number): SustainPedalEvent => ({ time, on: true, value: 127 })
const release = (time: number): SustainPedalEvent => ({ time, on: false, value: 0 })

describe('buildPedalIntervals', () => {
  it('pairs a press with its release', () => {
    expect(buildPedalIntervals([press(1), release(5)])).toEqual([{ down: 1, up: 5 }])
  })

  it('keeps a press open to the end of the file when never released', () => {
    expect(buildPedalIntervals([press(1)])).toEqual([{ down: 1, up: null }])
  })

  it('extends one span across repeated presses', () => {
    expect(buildPedalIntervals([press(1), press(2), release(5)])).toEqual([{ down: 1, up: 5 }])
  })

  it('ignores a release with no span open', () => {
    expect(buildPedalIntervals([release(1)])).toEqual([])
  })

  it('drops a zero-length press', () => {
    expect(buildPedalIntervals([press(1), release(1)])).toEqual([])
  })

  it('builds multiple spans', () => {
    expect(buildPedalIntervals([press(1), release(2), press(3), release(4)])).toEqual([
      { down: 1, up: 2 },
      { down: 3, up: 4 }
    ])
  })
})

describe('heldByPedal', () => {
  const intervals = [
    { down: 1, up: 5 },
    { down: 7, up: null }
  ]

  it('holds a note released inside a span', () => {
    expect(heldByPedal(intervals, 3)).toEqual(intervals[0])
  })

  it('holds a note released before the end of an open span', () => {
    expect(heldByPedal(intervals, 8)).toEqual(intervals[1])
  })

  it('does not hold a note released after the pedal lifted', () => {
    expect(heldByPedal(intervals, 6)).toBeNull()
  })

  it('does not hold a note released exactly as the pedal lifts', () => {
    expect(heldByPedal(intervals, 5)).toBeNull()
  })

  it('does not hold a note released before any press', () => {
    expect(heldByPedal(intervals, 0.5)).toBeNull()
  })
})