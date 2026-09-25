import { describe, expect, it } from 'vitest'
import { formatHoursMinutes, formatOrdinal } from './format'

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

describe('formatOrdinal', () => {
  it('uses st, nd, rd and th, with the teens always th', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(formatOrdinal))
      .toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th'])
  })
})
