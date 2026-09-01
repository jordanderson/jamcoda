/**
 * Silent stretches inside an annotation.
 *
 * A long annotation often spans a pause where nothing was played -- the end of
 * one take and the start of the next. Surfacing those lets the detail page
 * offer a split or a trim instead of leaving the operator to eyeball the roll.
 */

/** Pauses shorter than this are musical rests, not take boundaries. */
export const LARGE_ANNOTATION_GAP_SECONDS = 6

/**
 * Slack for deciding whether a gap touches an annotation's edge. Times are
 * stored to the millisecond, so an exact comparison would call a gap a
 * fraction inside the annotation "interior" and offer a zero-length split.
 */
export const GAP_EDGE_EPSILON = 0.001

export interface GapNote {
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
 * considered.
 */
export function getLargeAnnotationGaps(
  start: number,
  end: number,
  notes: GapNote[],
  minGapSec: number
): AnnotationGap[] {
  if (!(end > start)) return []

  const overlaps: Array<{ start: number; end: number }> = []
  for (const note of notes) {
    const noteStart = note.startTime ?? 0
    const noteEnd = note.endTime ?? noteStart
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
