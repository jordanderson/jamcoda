import { describe, expect, it } from 'vitest'
import { getGapAction, getLargeAnnotationGaps } from './annotationGaps'

const note = (startTime: number, endTime: number) => ({ startTime, endTime })

describe('getLargeAnnotationGaps', () => {
  it('finds an interior pause', () => {
    const gaps = getLargeAnnotationGaps(0, 30, [note(0, 5), note(20, 30)], 6)

    expect(gaps).toEqual([{ startTime: 5, endTime: 20, durationSec: 15 }])
  })

  it('ignores pauses shorter than the threshold', () => {
    expect(getLargeAnnotationGaps(0, 30, [note(0, 12), note(15, 30)], 6)).toEqual([])
  })

  it('treats an annotation with no notes as one long gap', () => {
    expect(getLargeAnnotationGaps(10, 30, [note(0, 5), note(40, 50)], 6)).toEqual([
      { startTime: 10, endTime: 30, durationSec: 20 }
    ])
  })

  it('leaves an empty short annotation alone', () => {
    expect(getLargeAnnotationGaps(10, 12, [], 6)).toEqual([])
  })

  it('reports leading and trailing silence', () => {
    const gaps = getLargeAnnotationGaps(0, 40, [note(10, 25)], 6)

    expect(gaps).toEqual([
      { startTime: 0, endTime: 10, durationSec: 10 },
      { startTime: 25, endTime: 40, durationSec: 15 }
    ])
  })

  it('clips notes to the annotation window', () => {
    // A note starting before the annotation still covers its opening.
    expect(getLargeAnnotationGaps(10, 30, [note(0, 25), note(26, 30)], 6)).toEqual([])
  })

  it('merges overlapping and unsorted notes before measuring', () => {
    const gaps = getLargeAnnotationGaps(
      0,
      40,
      [note(20, 30), note(0, 12), note(8, 21), note(29, 40)],
      6
    )

    expect(gaps).toEqual([])
  })

  it('returns nothing for an inverted or empty window', () => {
    expect(getLargeAnnotationGaps(30, 10, [], 6)).toEqual([])
    expect(getLargeAnnotationGaps(10, 10, [], 6)).toEqual([])
  })

  it('treats a note with no end as instantaneous', () => {
    const gaps = getLargeAnnotationGaps(0, 20, [{ startTime: 10, endTime: null }], 6)

    expect(gaps).toEqual([
      { startTime: 0, endTime: 10, durationSec: 10 },
      { startTime: 10, endTime: 20, durationSec: 10 }
    ])
  })
})

describe('getGapAction', () => {
  const annotation = { start_time: 100, end_time: 200 }

  it('splits an interior gap', () => {
    expect(getGapAction({ startTime: 140, endTime: 150, durationSec: 10 }, annotation))
      .toBe('split')
  })

  it('trims a gap flush with the start', () => {
    expect(getGapAction({ startTime: 100, endTime: 130, durationSec: 30 }, annotation))
      .toBe('trim-start')
  })

  it('trims a gap flush with the end', () => {
    expect(getGapAction({ startTime: 170, endTime: 200, durationSec: 30 }, annotation))
      .toBe('trim-end')
  })

  it('offers nothing for a gap covering the whole annotation', () => {
    // Both edits would leave a zero-length annotation.
    expect(getGapAction({ startTime: 100, endTime: 200, durationSec: 100 }, annotation))
      .toBe('none')
  })

  it('treats a sub-millisecond inset as flush with the edge', () => {
    // Times are stored to the millisecond. An exact comparison would call this
    // interior and offer a split leaving an empty segment.
    expect(getGapAction({ startTime: 100.0005, endTime: 130, durationSec: 30 }, annotation))
      .toBe('trim-start')
  })
})
