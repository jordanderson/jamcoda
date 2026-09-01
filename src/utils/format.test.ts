import { describe, expect, it } from 'vitest'
import { formatHoursMinutes } from './format'

describe('formatHoursMinutes', () => {
  it('drops the hour part below an hour', () => {
    expect(formatHoursMinutes(0)).toBe('0m')
    expect(formatHoursMinutes(90)).toBe('1m')
    expect(formatHoursMinutes(3599)).toBe('59m')
  })

  it('reads library-sized totals as hours and minutes', () => {
    expect(formatHoursMinutes(3600)).toBe('1h 0m')
    expect(formatHoursMinutes(7199)).toBe('1h 59m')
    expect(formatHoursMinutes(698400)).toBe('194h 0m')
  })

  it('never renders a negative duration', () => {
    expect(formatHoursMinutes(-5)).toBe('0m')
  })
})
