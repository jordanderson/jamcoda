import { describe, expect, it } from 'vitest'
import { estimateSyncSecondsRemaining } from './syncEta'
import { formatEta } from '../../utils/format'

describe('estimateSyncSecondsRemaining', () => {
  it('waits for enough files and time before estimating', () => {
    expect(estimateSyncSecondsRemaining(0, 100, null)).toBeNull()
    expect(estimateSyncSecondsRemaining(2, 100, 60_000)).toBeNull()
    expect(estimateSyncSecondsRemaining(10, 100, 1_000)).toBeNull()
  })

  it('projects the average rate over the remaining files', () => {
    expect(estimateSyncSecondsRemaining(10, 100, 20_000)).toBe(180)
  })

  it('has nothing to estimate once every file is processed', () => {
    expect(estimateSyncSecondsRemaining(100, 100, 200_000)).toBeNull()
  })
})

describe('formatEta', () => {
  it('rounds up and scales its unit', () => {
    expect(formatEta(0.2)).toBe('about 1s')
    expect(formatEta(59)).toBe('about 59s')
    expect(formatEta(61)).toBe('about 2m')
    expect(formatEta(4800)).toBe('about 1h 20m')
  })
})
