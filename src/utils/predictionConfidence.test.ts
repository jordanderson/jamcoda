import { describe, expect, it } from 'vitest'
import {
  BAND_DESCRIPTIONS,
  calibratedConfidence,
  confidenceBand
} from './predictionConfidence'

describe('calibratedConfidence', () => {
  it('rates a long take above a short burst that scored a higher raw margin', () => {
    // The defect this calibration exists to fix. Raw margin says the 20-second
    // fragment is more than twice as confident as the four-minute take; the
    // review verdicts say the opposite.
    const longTake = calibratedConfidence(0.4, 240)!
    const shortBurst = calibratedConfidence(0.9, 20)!

    expect(longTake.probability).toBeGreaterThan(shortBurst.probability)
    expect(longTake.band).toBe('strong')
    expect(shortBurst.band).toBe('uncertain')
  })

  it('reads a correct 40% segment as a strong match', () => {
    // The reported case: a correct Winter Wonderland take displayed at 40%.
    const result = calibratedConfidence(0.4, 180)!
    expect(result.probability).toBeGreaterThan(0.8)
    expect(result.label).toBe('86%')
    expect(result.band).toBe('strong')
  })

  it('increases monotonically with duration at a fixed margin', () => {
    const durations = [10, 30, 60, 120, 300, 600]
    const probabilities = durations.map((d) => calibratedConfidence(0.4, d)!.probability)
    for (let i = 1; i < probabilities.length; i++) {
      expect(probabilities[i]).toBeGreaterThan(probabilities[i - 1])
    }
  })

  it('decreases with raw margin at a fixed duration, as the fit found', () => {
    const low = calibratedConfidence(0.3, 120)!.probability
    const high = calibratedConfidence(0.9, 120)!.probability
    expect(high).toBeLessThan(low)
  })

  it('stays inside [0, 1] for extreme inputs', () => {
    for (const [margin, duration] of [[0, 1e9], [1, 0], [0, 0], [1, 1e9]] as const) {
      const result = calibratedConfidence(margin, duration)!
      expect(result.probability).toBeGreaterThanOrEqual(0)
      expect(result.probability).toBeLessThanOrEqual(1)
      expect(Number.isNaN(result.probability)).toBe(false)
    }
  })

  it('floors duration at one second rather than diverging below it', () => {
    // log10 of a sub-second duration is negative and unbounded; the decoder's
    // window step is one second, so nothing shorter carries its own evidence.
    expect(calibratedConfidence(0.4, 0.01)!.probability)
      .toBe(calibratedConfidence(0.4, 1)!.probability)
    expect(calibratedConfidence(0.4, 0)!.probability)
      .toBe(calibratedConfidence(0.4, 1)!.probability)
  })

  it('returns null for a row with no stored margin', () => {
    // Older rows predate the field. Rendering nothing beats inventing a number.
    expect(calibratedConfidence(null, 120)).toBeNull()
    expect(calibratedConfidence(Number.NaN, 120)).toBeNull()
    expect(calibratedConfidence(0.4, Number.NaN)).toBeNull()
  })

  it('formats the label as a whole percentage', () => {
    expect(calibratedConfidence(0.4, 180)!.label).toMatch(/^\d{1,3}%$/)
  })
})

describe('confidenceBand', () => {
  it('splits at the thresholds the calibration bends on', () => {
    expect(confidenceBand(0.75)).toBe('strong')
    expect(confidenceBand(0.749)).toBe('likely')
    expect(confidenceBand(0.55)).toBe('likely')
    expect(confidenceBand(0.549)).toBe('uncertain')
  })

  it('describes every band', () => {
    for (const probability of [0.2, 0.6, 0.9]) {
      expect(BAND_DESCRIPTIONS[confidenceBand(probability)]).toBeTruthy()
    }
  })
})
