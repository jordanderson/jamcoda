import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clamp } from '@core/math'
import type { RollAnnotation } from '@/components/midi/pianoRollTypes'
import type { AnnotationResizeEdge } from '@/components/midi/PianoRollTimelines'

const MIN_ANNOTATION_DURATION_SECONDS = 0.1
const RESIZE_SYNC_EPSILON_SECONDS = 0.002

interface ResizeDraft {
  annotationId: number
  startTime: number
  endTime: number
}

interface ResizeSession {
  annotationId: number
  edge: AnnotationResizeEdge
  startClientX: number
  initialStartTime: number
  initialEndTime: number
}

interface UseAnnotationResizeOptions {
  annotations: RollAnnotation[]
  pixelsPerTimeStep: number
  onAnnotationResize?: (
    annotationId: number,
    times: { startTime: number; endTime: number }
  ) => void | Promise<void>
}

function roundToMillis(value: number): number {
  return Math.round(value * 1000) / 1000
}

function matchesDraft(candidate: ResizeDraft, draft: ResizeDraft): boolean {
  return (
    candidate.annotationId === draft.annotationId
    && Math.abs(candidate.startTime - draft.startTime) <= RESIZE_SYNC_EPSILON_SECONDS
    && Math.abs(candidate.endTime - draft.endTime) <= RESIZE_SYNC_EPSILON_SECONDS
  )
}

/**
 * Drag-to-resize for annotation chips on the timeline row.
 *
 * The draft is local so the chip tracks the pointer without a round trip, and
 * is cleared once the saved annotation catches up (or at once, if the save
 * is rejected). Pointer listeners live on the window because a drag always
 * leaves the handle.
 */
export function useAnnotationResize({
  annotations,
  pixelsPerTimeStep,
  onAnnotationResize
}: UseAnnotationResizeOptions) {
  const sessionRef = useRef<ResizeSession | null>(null)
  const draftRef = useRef<ResizeDraft | null>(null)
  const [draft, setDraft] = useState<ResizeDraft | null>(null)
  const [isResizing, setIsResizing] = useState(false)

  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  /** Annotations with the in-flight drag applied, for rendering. */
  const displayedAnnotations = useMemo(() => {
    if (!draft) return annotations
    return annotations.map((annotation) => (
      annotation.id === draft.annotationId
        ? { ...annotation, start_time: draft.startTime, end_time: draft.endTime }
        : annotation
    ))
  }, [annotations, draft])

  // Drop the draft once the saved annotation agrees with it, or once the
  // annotation disappears (deleted while the save was in flight).
  useEffect(() => {
    if (!draft || isResizing) return
    const annotation = annotations.find((item) => item.id === draft.annotationId)
    if (!annotation) {
      setDraft(null)
      return
    }
    if (matchesDraft({
      annotationId: draft.annotationId,
      startTime: annotation.start_time,
      endTime: annotation.end_time
    }, draft)) {
      setDraft(null)
    }
  }, [annotations, draft, isResizing])

  useEffect(() => {
    if (!isResizing) return

    const handlePointerMove = (event: PointerEvent) => {
      const session = sessionRef.current
      if (!session) return

      const deltaTime = (event.clientX - session.startClientX) / pixelsPerTimeStep
      const nextStartTime = session.edge === 'start'
        ? clamp(
          session.initialStartTime + deltaTime,
          0,
          session.initialEndTime - MIN_ANNOTATION_DURATION_SECONDS
        )
        : session.initialStartTime
      const nextEndTime = session.edge === 'end'
        ? Math.max(
          session.initialStartTime + MIN_ANNOTATION_DURATION_SECONDS,
          session.initialEndTime + deltaTime
        )
        : session.initialEndTime

      setDraft({
        annotationId: session.annotationId,
        startTime: roundToMillis(nextStartTime),
        endTime: roundToMillis(nextEndTime)
      })
    }

    const stopResizing = (commit: boolean) => {
      const session = sessionRef.current
      const pending = draftRef.current
      sessionRef.current = null
      setIsResizing(false)

      if (!commit || !session || !pending) {
        setDraft(null)
        return
      }

      const didChange = (
        Math.abs(pending.startTime - session.initialStartTime) > RESIZE_SYNC_EPSILON_SECONDS
        || Math.abs(pending.endTime - session.initialEndTime) > RESIZE_SYNC_EPSILON_SECONDS
      )
      if (!didChange || !onAnnotationResize) {
        setDraft(null)
        return
      }

      // Either way the draft is released. A rejected save snaps the chip back
      // to the stored times.
      const release = () => {
        setDraft((current) => (current && matchesDraft(current, pending) ? null : current))
      }

      Promise.resolve(
        onAnnotationResize(session.annotationId, {
          startTime: pending.startTime,
          endTime: pending.endTime
        })
      )
        .then(release)
        .catch((error) => {
          console.error('Failed to resize annotation:', error)
          release()
        })
    }

    const handlePointerUp = () => stopResizing(true)
    const handlePointerCancel = () => stopResizing(false)

    const previousUserSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'ew-resize'

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)

    return () => {
      document.body.style.userSelect = previousUserSelect
      document.body.style.cursor = previousCursor
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
    }
  }, [isResizing, onAnnotationResize, pixelsPerTimeStep])

  const handleResizePointerDown = useCallback((
    event: React.PointerEvent<HTMLButtonElement>,
    annotation: RollAnnotation,
    edge: AnnotationResizeEdge
  ) => {
    event.preventDefault()
    event.stopPropagation()

    sessionRef.current = {
      annotationId: annotation.id,
      edge,
      startClientX: event.clientX,
      initialStartTime: annotation.start_time,
      initialEndTime: annotation.end_time
    }
    setDraft({
      annotationId: annotation.id,
      startTime: annotation.start_time,
      endTime: annotation.end_time
    })
    setIsResizing(true)
  }, [])

  return {
    displayedAnnotations,
    resizingAnnotationId: draft?.annotationId ?? null,
    isResizing,
    handleResizePointerDown
  }
}
