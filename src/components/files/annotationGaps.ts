import {
  buildPedalIntervals,
  heldByPedal,
  type SustainPedalEvent
} from '@core/midi/noteSequence'

/**
 * Silent stretches inside an annotation.
 *
 * A long annotation often spans a pause where nothing was played -- the end of
 * one take and the start of the next. Surfacing those lets the detail page
 * offer a split or a trim instead of leaving the operator to eyeball the roll.
 */

/**
 * Pauses shorter than this are musical rests, not take boundaries.
 * With pedal modeling accounting for ringing sound under held damper pedals,
 * true acoustic pauses of 3.5s or longer represent take breaks, sheet-reading pauses,
 * or stops.
 */
export const LARGE_ANNOTATION_GAP_SECONDS = 3.5

/**
 * Slack for deciding whether a gap touches an annotation's edge. Times are
 * stored to the millisecond, so an exact comparison would call a gap a
 * fraction inside the annotation "interior" and offer a zero-length split.
 */
export const GAP_EDGE_EPSILON = 0.001

export interface GapNote {
  pitch?: number | null
  startTime?: number | null
  endTime?: number | null
}

export interface AnnotationGap {
  startTime: number
  endTime: number
  durationSec: number
}

/** Which edit a gap admits, given where it sits in its annotation. */
export type GapAction = 'split' | 'trim-start' | 'trim-end' | 'none'

/**
 * Gaps of at least `minGapSec` between `start` and `end` where no note sounds.
 *
 * `notes` may cover the whole file. Only the parts overlapping the window are
 * considered. When `sustainEvents` are provided, notes held by the damper pedal
 * (CC 64) are extended acoustically until the pedal lifts or natural decay ends.
 */
export function getLargeAnnotationGaps(
  start: number,
  end: number,
  notes: GapNote[],
  minGapSec: number = LARGE_ANNOTATION_GAP_SECONDS,
  sustainEvents?: SustainPedalEvent[]
): AnnotationGap[] {
  if (!(end > start)) return []

  const intervals = sustainEvents && sustainEvents.length > 0
    ? buildPedalIntervals(sustainEvents)
    : []

  const overlaps: Array<{ start: number; end: number }> = []
  for (const note of notes) {
    const noteStart = note.startTime ?? 0
    let noteEnd = note.endTime ?? noteStart

    if (intervals.length > 0 && note.endTime != null) {
      const held = heldByPedal(intervals, note.endTime)
      if (held) {
        const pitchMax = note.pitch != null && note.pitch > 72 ? 1.5 : 2.5
        const pedalRelease = held.up !== null ? held.up : note.endTime + pitchMax
        noteEnd = Math.max(noteEnd, Math.min(pedalRelease, note.endTime + pitchMax))
      }
    }

    if (noteEnd <= start || noteStart >= end) {
      continue
    }
    overlaps.push({
      start: Math.max(start, noteStart),
      end: Math.min(end, noteEnd)
    })
  }

  if (overlaps.length === 0) {
    const fullGap = end - start
    return fullGap >= minGapSec
      ? [{ startTime: start, endTime: end, durationSec: fullGap }]
      : []
  }

  overlaps.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: Array<{ start: number; end: number }> = [overlaps[0]]

  for (let i = 1; i < overlaps.length; i++) {
    const current = overlaps[i]
    const last = merged[merged.length - 1]
    if (current.start > last.end) {
      merged.push(current)
      continue
    }
    if (current.end > last.end) {
      last.end = current.end
    }
  }

  const gaps: AnnotationGap[] = []
  const addGapIfLarge = (gapStart: number, gapEnd: number) => {
    const durationSec = gapEnd - gapStart
    if (durationSec >= minGapSec) {
      gaps.push({ startTime: gapStart, endTime: gapEnd, durationSec })
    }
  }

  addGapIfLarge(start, merged[0].start)
  for (let i = 1; i < merged.length; i++) {
    addGapIfLarge(merged[i - 1].end, merged[i].start)
  }
  addGapIfLarge(merged[merged.length - 1].end, end)

  return gaps
}

/**
 * The one edit a gap admits. An interior gap splits the annotation. A gap
 * flush against one edge trims that edge inward. A gap covering the whole
 * annotation admits neither. Deciding it here keeps the button's label,
 * handler, and disabled state from disagreeing.
 */
export function getGapAction(
  gap: AnnotationGap,
  annotation: { start_time: number; end_time: number }
): GapAction {
  const touchesStart = gap.startTime <= annotation.start_time + GAP_EDGE_EPSILON
  const touchesEnd = gap.endTime >= annotation.end_time - GAP_EDGE_EPSILON

  if (!touchesStart && !touchesEnd) return 'split'
  if (touchesStart && touchesEnd) return 'none'
  return touchesStart ? 'trim-start' : 'trim-end'
}
