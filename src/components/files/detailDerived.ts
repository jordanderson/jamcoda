/**
 * Pure derivations behind the detail page.
 *
 * The page re-renders every animation frame during playback, so each of these
 * sits behind a `useMemo` there. Keeping them out of the component makes them
 * testable on their own and keeps the dependency arrays honest.
 */
import type { NoteSequence } from '@core/midi/noteSequence'
import { buildPedalIntervals, heldByPedal } from '@core/midi/noteSequence'
import { resolveReviewFields } from '@core/predictionReview'
import { partsForReview } from '@core/predictionEvidence'
import { clipParts } from '@core/timeRanges'
import type { BoundaryNote } from '@core/boundaries'
import type { PredictionReview } from '@/api/localTypes'
import type { RollBookmark, RollPrediction, RollSkip } from '@/components/midi/pianoRollTypes'
import type { DeviceMarker } from './DetailDeviceMarkers'
import { formatTimeHms } from '@/utils/format'

/** Device silence gaps shorter than this are noise, not passage boundaries. */
export const MIN_SKIP_DISPLAY_SEC = 8

/** A pedalled note keeps ringing this long past its release, less above C5. */
const PEDAL_TAIL_SEC = 0.7
const PEDAL_TAIL_SEC_HIGH = 0.6
const HIGH_REGISTER_PITCH = 72

/**
 * Notes annotated with when they stop sounding rather than when the key was
 * released, which is what boundary snapping aligns to.
 */
export function buildAcousticNotes(sequence: NoteSequence | null | undefined): BoundaryNote[] {
  if (!sequence?.notes) return []

  const intervals = sequence.sustainEvents?.length
    ? buildPedalIntervals(sequence.sustainEvents)
    : []

  return sequence.notes.map((note) => {
    const tail = note.pitch > HIGH_REGISTER_PITCH ? PEDAL_TAIL_SEC_HIGH : PEDAL_TAIL_SEC
    const held = intervals.length > 0 ? heldByPedal(intervals, note.endTime) : null
    const pedalRelease = held?.up ?? note.endTime + tail

    return {
      pitch: note.pitch,
      velocity: note.velocity,
      startTime: note.startTime,
      endTime: note.endTime,
      acousticEndSec: held ? Math.min(pedalRelease, note.endTime + tail) : note.endTime
    }
  })
}

/** Passage bookmarks and long recorded pauses, as one timeline of markers. */
export function buildDeviceMarkers(
  bookmarks: RollBookmark[],
  skips: RollSkip[]
): DeviceMarker[] {
  const bookmarkMarkers: DeviceMarker[] = bookmarks.map((bookmark) => ({
    key: `bm-${bookmark.bookmarkIdx}`,
    timeSec: bookmark.timeSec,
    kind: 'bookmark',
    label: `BM ${bookmark.bookmarkIdx} · ${formatTimeHms(bookmark.timeSec)}`
  }))

  const skipMarkers: DeviceMarker[] = skips
    .filter((skip) => skip.millis >= MIN_SKIP_DISPLAY_SEC * 1000)
    .map((skip, index) => ({
      key: `skip-${skip.timeSec.toFixed(3)}-${index}`,
      timeSec: skip.timeSec,
      kind: 'skip',
      label: formatTimeHms(skip.timeSec),
      gapSec: Math.round(skip.millis / 1000)
    }))

  return [...bookmarkMarkers, ...skipMarkers].sort((a, b) => a.timeSec - b.timeSec)
}

/**
 * Reviews as drawable roll segments, clamped to the sequence's own end.
 *
 * `invalid` rows are rejected predictions and are not drawn. A review still
 * awaiting a verdict carries its evidence parts, fitted to the bounds it is
 * drawn with; a reviewed one does not, since the reviewer has already checked
 * the places the parts would flag.
 */
export function buildPredictionSegments(
  reviews: PredictionReview[],
  timelineEndLimit: number | undefined
): RollPrediction[] {
  return reviews
    .filter((review) => review.status !== 'invalid')
    .map((review): RollPrediction | null => {
      const { songName, startTime, endTime } = resolveReviewFields(review)
      if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null

      const drawnStart = Math.max(0, startTime)
      const drawnEnd = timelineEndLimit === undefined ? endTime : Math.min(timelineEndLimit, endTime)
      const parts = partsForReview(review)
      return {
        id: review.id,
        songName,
        startTime: drawnStart,
        endTime: drawnEnd,
        confidence: review.predicted_confidence ?? null,
        ...(parts.length > 0 ? { parts: clipParts(parts, drawnStart, drawnEnd) } : {})
      }
    })
    .filter((segment): segment is RollPrediction => (
      segment !== null && segment.endTime > segment.startTime
    ))
    .sort((a, b) => a.startTime - b.startTime || a.id - b.id)
}

/**
 * The one model behind the queue on screen, when they agree.
 *
 * Mixed versions mean the queue was built in more than one pass, which is not
 * a baseline either, so it is reported as such rather than picking one.
 */
export function resolveQueueModelVersion(reviews: PredictionReview[]): string | undefined {
  const versions = new Set(
    reviews
      .map((review) => review.model_version)
      .filter((version): version is string => Boolean(version))
  )
  if (versions.size === 0) return undefined
  return versions.size === 1 ? [...versions][0] : 'several runs'
}
