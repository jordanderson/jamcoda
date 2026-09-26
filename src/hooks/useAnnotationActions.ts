import { useCallback, useState } from 'react'
import { useSplitAnnotation, useUpdateAnnotation } from '@/hooks/useAnnotations'
import type { ShowToast } from '@/hooks/useToasts'
import type { RollAnnotation } from '@/components/midi/pianoRollTypes'
import { snapSegmentBoundaries, type BoundaryNote } from '@core/boundaries'
import { errorMessage } from '@core/errors'
import { formatTime } from '@/utils/format'
import { getGapAction, type AnnotationGap } from '@/components/files/annotationGaps'

/** An annotation's bounds are equal to the snapped ones within this tolerance. */
const ALREADY_SNAPPED_SEC = 0.02

interface UseAnnotationActionsOptions {
  /** Notes with pedal-extended ends, for boundary snapping. */
  acousticNotes: BoundaryNote[]
  showToast: ShowToast
  /** Closes the annotation modal after a split made from a selected region. */
  onRegionSplitDone: () => void
}

export interface AnnotationActions {
  /** `${annotationId}:${gapIndex}` while that gap's button is working. */
  splittingGapKey: string | null
  resize: (annotationId: number, times: { startTime: number; endTime: number }) => Promise<void>
  splitAtGap: (annotation: RollAnnotation, gap: AnnotationGap, gapIndex: number) => Promise<void>
  splitAtRegion: (
    annotation: { id: number; song_name: string; start_time: number; end_time: number },
    startTime: number,
    endTime: number
  ) => Promise<void>
  trimAtGap: (annotation: RollAnnotation, gap: AnnotationGap, gapIndex: number) => Promise<void>
  snapBounds: (annotation: RollAnnotation) => Promise<void>
}

/**
 * The annotation edits reachable from the detail page.
 *
 * Each one validates, mutates, and reports through a toast; they live here so
 * the page itself stays a composition of hooks and markup.
 */
export function useAnnotationActions({
  acousticNotes,
  showToast,
  onRegionSplitDone
}: UseAnnotationActionsOptions): AnnotationActions {
  const updateAnnotation = useUpdateAnnotation()
  const splitAnnotation = useSplitAnnotation()
  const [splittingGapKey, setSplittingGapKey] = useState<string | null>(null)

  const fail = useCallback((error: unknown, fallback: string) => {
    showToast({ type: 'error', message: errorMessage(error, fallback) })
  }, [showToast])

  const reject = useCallback((message: string) => {
    showToast({ type: 'error', message })
  }, [showToast])

  const succeed = useCallback((message: string) => {
    showToast({ type: 'success', message })
  }, [showToast])

  /** Marks a gap's button busy for the duration of `work`. */
  const withGapBusy = useCallback(async (key: string, work: () => Promise<void>) => {
    setSplittingGapKey(key)
    try {
      await work()
    } finally {
      setSplittingGapKey((current) => (current === key ? null : current))
    }
  }, [])

  /**
   * Resize rejects rather than toasting alone: the caller reverts the drag on
   * a rejected promise.
   */
  const resize = useCallback(async (
    annotationId: number,
    times: { startTime: number; endTime: number }
  ) => {
    const invalid = !Number.isFinite(times.startTime) || !Number.isFinite(times.endTime)
      ? 'Resized label has invalid time values.'
      : times.startTime >= times.endTime
        ? 'Label start time must be less than end time.'
        : null

    if (invalid) {
      reject(invalid)
      throw new Error(invalid)
    }

    try {
      await updateAnnotation.mutateAsync({
        id: annotationId,
        data: { startTime: times.startTime, endTime: times.endTime }
      })
    } catch (error) {
      fail(error, 'Failed to resize label.')
      throw error
    }
  }, [fail, reject, updateAnnotation.mutateAsync])

  const splitAtGap = useCallback(async (
    annotation: RollAnnotation,
    gap: AnnotationGap,
    gapIndex: number
  ) => {
    if (getGapAction(gap, annotation) !== 'split') {
      reject('This gap is at the edge of the label and cannot be split into two segments.')
      return
    }

    await withGapBusy(`${annotation.id}:${gapIndex}`, async () => {
      try {
        await splitAnnotation.mutateAsync({
          id: annotation.id,
          holeStartTime: gap.startTime,
          holeEndTime: gap.endTime
        })
        succeed(`Split label at gap ${formatTime(gap.startTime)} - ${formatTime(gap.endTime)}.`)
      } catch (error) {
        fail(error, 'Failed to split label at this gap.')
      }
    })
  }, [fail, reject, splitAnnotation.mutateAsync, succeed, withGapBusy])

  const splitAtRegion = useCallback(async (
    annotation: { id: number; song_name: string; start_time: number; end_time: number },
    startTime: number,
    endTime: number
  ) => {
    const holeStart = Number(startTime.toFixed(3))
    const holeEnd = Number(endTime.toFixed(3))

    if (
      holeStart <= annotation.start_time
      || holeEnd >= annotation.end_time
      || holeStart >= holeEnd
    ) {
      reject('The selected split region must be strictly inside the existing label.')
      return
    }

    try {
      await splitAnnotation.mutateAsync({
        id: annotation.id,
        holeStartTime: holeStart,
        holeEndTime: holeEnd
      })
      succeed(
        `Split "${annotation.song_name}" into two segments with a hole from `
        + `${formatTime(holeStart)} to ${formatTime(holeEnd)}.`
      )
      onRegionSplitDone()
    } catch (error) {
      fail(error, 'Failed to split label.')
    }
  }, [fail, onRegionSplitDone, reject, splitAnnotation.mutateAsync, succeed])

  const trimAtGap = useCallback(async (
    annotation: RollAnnotation,
    gap: AnnotationGap,
    gapIndex: number
  ) => {
    const action = getGapAction(gap, annotation)
    if (action !== 'trim-start' && action !== 'trim-end') {
      reject('This gap cannot be trimmed automatically.')
      return
    }

    // Trimming the end pulls it back to where the silence began; trimming the
    // start pushes it forward to where the playing resumed.
    const trimmed = action === 'trim-end'
      ? { data: { endTime: gap.startTime }, at: gap.startTime, edge: 'end' }
      : { data: { startTime: gap.endTime }, at: gap.endTime, edge: 'start' }

    await withGapBusy(`${annotation.id}:${gapIndex}`, async () => {
      try {
        await updateAnnotation.mutateAsync({ id: annotation.id, data: trimmed.data })
        succeed(`Trimmed label ${trimmed.edge} to ${formatTime(trimmed.at)}.`)
      } catch (error) {
        fail(error, 'Failed to trim label at this gap.')
      }
    })
  }, [fail, reject, succeed, updateAnnotation.mutateAsync, withGapBusy])

  const snapBounds = useCallback(async (annotation: RollAnnotation) => {
    if (acousticNotes.length === 0) return

    const snapped = snapSegmentBoundaries(
      annotation.start_time,
      annotation.end_time,
      acousticNotes,
      { trimFlourish: false }
    )

    if (
      Math.abs(snapped.startTime - annotation.start_time) < ALREADY_SNAPPED_SEC
      && Math.abs(snapped.endTime - annotation.end_time) < ALREADY_SNAPPED_SEC
    ) {
      succeed('Label is already aligned with played notes.')
      return
    }

    try {
      await updateAnnotation.mutateAsync({
        id: annotation.id,
        data: { startTime: snapped.startTime, endTime: snapped.endTime }
      })
      succeed(`Snapped bounds to ${formatTime(snapped.startTime)} - ${formatTime(snapped.endTime)}.`)
    } catch (error) {
      fail(error, 'Failed to snap bounds.')
    }
  }, [acousticNotes, fail, succeed, updateAnnotation.mutateAsync])

  return { splittingGapKey, resize, splitAtGap, splitAtRegion, trimAtGap, snapBounds }
}
