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
 * A note's sounding span, with pedal sustain already applied.
 *
 * Spans are a property of the file, not of any one annotation, so they are
 * built once and reused across every annotation on the page --
 * `buildSoundingSpans` is the expensive half of gap detection and it does not
 * depend on the window being measured.
 */
export interface SoundingSpan {
  start: number
  end: number
}

/**
 * Every note's sounding span for a file, sorted by start, with damper pedal
 * (CC 64) sustain applied: a note released while the pedal is down rings on
 * until the pedal lifts or natural decay ends, whichever comes first.
 *
 * Sorted so that `getSoundingGaps` can binary-search the window it needs
 * instead of rescanning the whole file per annotation.
 */
export function buildSoundingSpans(
  notes: GapNote[],
  sustainEvents?: SustainPedalEvent[]
): SoundingSpan[] {
  const intervals = sustainEvents && sustainEvents.length > 0
    ? buildPedalIntervals(sustainEvents)
    : []

  const spans: SoundingSpan[] = []
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

    spans.push({ start: noteStart, end: noteEnd })
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  return spans
}

/** Index of the first span that could reach into `start`. */
function firstSpanIndexFrom(spans: SoundingSpan[], start: number): number {
  // Spans are sorted by start, but a long earlier note can still cover the
  // window, so walk back over any span whose end reaches past `start`.
  let low = 0
  let high = spans.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (spans[mid].start < start) {
      low = mid + 1
    } else {
      high = mid
    }
  }

  let index = low
  while (index > 0 && spans[index - 1].end > start) {
    index--
  }
  return index
}

/**
 * Gaps of at least `minGapSec` in `[start, end]` where no span sounds.
 *
 * `spans` may cover the whole file; only the part overlapping the window is
 * walked.
 */
export function getSoundingGaps(
  spans: SoundingSpan[],
  start: number,
  end: number,
  minGapSec: number = LARGE_ANNOTATION_GAP_SECONDS
): AnnotationGap[] {
  if (!(end > start)) return []

  // Clipped to the window and merged. Clipping before merging is equivalent to
  // merging before clipping, so the result matches a whole-file union.
  const merged: Array<{ start: number; end: number }> = []
  for (let i = firstSpanIndexFrom(spans, start); i < spans.length; i++) {
    const span = spans[i]
    if (span.start >= end) break
    if (span.end <= start) continue

    const clippedStart = Math.max(start, span.start)
    const clippedEnd = Math.min(end, span.end)
    const last = merged[merged.length - 1]
    if (last && clippedStart <= last.end) {
      if (clippedEnd > last.end) last.end = clippedEnd
      continue
    }
    merged.push({ start: clippedStart, end: clippedEnd })
  }

  if (merged.length === 0) {
    const fullGap = end - start
    return fullGap >= minGapSec
      ? [{ startTime: start, endTime: end, durationSec: fullGap }]
      : []
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
 * Gaps of at least `minGapSec` between `start` and `end` where no note sounds.
 *
 * `notes` may cover the whole file. Only the parts overlapping the window are
 * considered. When `sustainEvents` are provided, notes held by the damper pedal
 * (CC 64) are extended acoustically until the pedal lifts or natural decay ends.
 *
 * One-shot convenience wrapper. A caller measuring several windows over the
 * same file should hoist `buildSoundingSpans` and call `getSoundingGaps`.
 */
export function getLargeAnnotationGaps(
  start: number,
  end: number,
  notes: GapNote[],
  minGapSec: number = LARGE_ANNOTATION_GAP_SECONDS,
  sustainEvents?: SustainPedalEvent[]
): AnnotationGap[] {
  if (!(end > start)) return []
  return getSoundingGaps(buildSoundingSpans(notes, sustainEvents), start, end, minGapSec)
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
