import { useEffect, useMemo, useRef, useState } from 'react'
import * as mm from '@magenta/music'
import { Trash2 } from 'lucide-react'
import { usePianoRollInteraction } from '@/hooks/usePianoRollInteraction'

interface Annotation {
  id: number
  song_name: string
  start_time: number
  end_time: number
  notes?: string
}

interface PianoRollVisualizerProps {
  sequence: mm.INoteSequence | null
  currentTime?: number
  isPlaying?: boolean
  annotations?: Annotation[]
  predictions?: Array<{
    id: number
    songName: string
    startTime: number
    endTime: number
    confidence: number | null
  }>
  ignoredSections?: Array<{
    id: number
    startTime: number
    endTime: number
    reason?: string
  }>
  startCheckpoint?: number | null
  endCheckpoint?: number | null
  onTimeClick?: (time: number) => void
  onRegionSelect?: (startTime: number, endTime: number) => void
  isAnnotationMode?: boolean
  snapToPlayback?: boolean
  onSnapToPlaybackChange?: (snap: boolean) => void
  onHoverTimeChange?: (time: number | null) => void
  onPredictionClick?: (predictionId: number) => void
  onIgnoredSectionClick?: (ignoredSectionId: number) => void
  onAnnotationDelete?: (annotationId: number) => void
  onAnnotationResize?: (
    annotationId: number,
    times: { startTime: number; endTime: number }
  ) => void | Promise<void>
}

type AnnotationResizeEdge = 'start' | 'end'

interface AnnotationResizeDraft {
  annotationId: number
  startTime: number
  endTime: number
}

interface AnnotationResizeSession {
  annotationId: number
  edge: AnnotationResizeEdge
  startClientX: number
  initialStartTime: number
  initialEndTime: number
}

const MIN_ANNOTATION_DURATION_SECONDS = 0.1
const RESIZE_SYNC_EPSILON_SECONDS = 0.002

export function PianoRollVisualizer({
  sequence,
  currentTime = 0,
  isPlaying = false,
  annotations = [],
  predictions = [],
  ignoredSections = [],
  startCheckpoint = null,
  endCheckpoint = null,
  onTimeClick,
  onRegionSelect,
  isAnnotationMode = false,
  snapToPlayback = true,
  onSnapToPlaybackChange,
  onHoverTimeChange,
  onPredictionClick,
  onIgnoredSectionClick,
  onAnnotationDelete,
  onAnnotationResize
}: PianoRollVisualizerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const visualizerRef = useRef<mm.PianoRollSVGVisualizer | null>(null)
  const configRef = useRef({ pixelsPerTimeStep: 50, noteHeight: 3 })
  const [hoverX, setHoverX] = useState<number | null>(null)
  const lastScrollTimeRef = useRef<number>(0)
  const programmaticScrollTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const lastProgrammaticScrollRef = useRef<number>(0)
  const resizeSessionRef = useRef<AnnotationResizeSession | null>(null)
  const resizeDraftRef = useRef<AnnotationResizeDraft | null>(null)
  const [annotationResizeDraft, setAnnotationResizeDraft] = useState<AnnotationResizeDraft | null>(null)
  const [isResizingAnnotation, setIsResizingAnnotation] = useState(false)

  // Use interaction hook for drag-to-select
  const { dragState, handlers, containerRef: svgContainerRef } = usePianoRollInteraction({
    pixelsPerTimeStep: configRef.current.pixelsPerTimeStep,
    onRegionSelect,
    onTimeClick,
    isEnabled: isAnnotationMode
  })

  useEffect(() => {
    resizeDraftRef.current = annotationResizeDraft
  }, [annotationResizeDraft])

  const displayedAnnotations = useMemo(() => {
    if (!annotationResizeDraft) {
      return annotations
    }
    return annotations.map((annotation) => {
      if (annotation.id !== annotationResizeDraft.annotationId) {
        return annotation
      }
      return {
        ...annotation,
        start_time: annotationResizeDraft.startTime,
        end_time: annotationResizeDraft.endTime
      }
    })
  }, [annotations, annotationResizeDraft])

  useEffect(() => {
    if (!annotationResizeDraft || isResizingAnnotation) return
    const annotation = annotations.find((item) => item.id === annotationResizeDraft.annotationId)
    if (!annotation) {
      setAnnotationResizeDraft(null)
      return
    }
    const startSynced = Math.abs(annotation.start_time - annotationResizeDraft.startTime) <= RESIZE_SYNC_EPSILON_SECONDS
    const endSynced = Math.abs(annotation.end_time - annotationResizeDraft.endTime) <= RESIZE_SYNC_EPSILON_SECONDS
    if (startSynced && endSynced) {
      setAnnotationResizeDraft(null)
    }
  }, [annotations, annotationResizeDraft, isResizingAnnotation])

  let maxOverlayEndTime = 0
  for (const annotation of displayedAnnotations) {
    if (annotation.end_time > maxOverlayEndTime) {
      maxOverlayEndTime = annotation.end_time
    }
  }
  for (const prediction of predictions) {
    if (prediction.endTime > maxOverlayEndTime) {
      maxOverlayEndTime = prediction.endTime
    }
  }
  for (const ignoredSection of ignoredSections) {
    if (ignoredSection.endTime > maxOverlayEndTime) {
      maxOverlayEndTime = ignoredSection.endTime
    }
  }
  const timelineTotalTime = Math.max(sequence?.totalTime || 0, maxOverlayEndTime)

  // Sync the interaction hook's SVG ref
  useEffect(() => {
    if (svgRef.current) {
      (svgContainerRef as any).current = svgRef.current
    }
  }, [svgContainerRef, sequence])

  // Rebuild visualizer when sequence changes so note geometry matches the active file.
  useEffect(() => {
    if (!sequence || !svgRef.current) return

    try {
      svgRef.current.innerHTML = ''
      visualizerRef.current = new mm.PianoRollSVGVisualizer(
        sequence,
        svgRef.current,
        {
          noteHeight: configRef.current.noteHeight,
          pixelsPerTimeStep: configRef.current.pixelsPerTimeStep,
          noteSpacing: 1,
          noteRGB: '148, 152, 229', // Matches theme color #9198E5
          activeNoteRGB: '230, 100, 101' // Matches theme color #E66465
        }
      )
      visualizerRef.current.redraw()
    } catch (err) {
      console.error('Error initializing piano roll visualizer:', err)
    }
  }, [sequence])

  useEffect(() => {
    if (!isResizingAnnotation) return

    const handlePointerMove = (event: PointerEvent) => {
      const session = resizeSessionRef.current
      if (!session) return

      const deltaTime = (event.clientX - session.startClientX) / configRef.current.pixelsPerTimeStep
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

      setAnnotationResizeDraft({
        annotationId: session.annotationId,
        startTime: roundToMillis(nextStartTime),
        endTime: roundToMillis(nextEndTime)
      })
    }

    const stopResizing = (commit: boolean) => {
      const session = resizeSessionRef.current
      const draft = resizeDraftRef.current
      resizeSessionRef.current = null
      setIsResizingAnnotation(false)

      if (!commit || !session || !draft) {
        setAnnotationResizeDraft(null)
        return
      }

      const didChange = (
        Math.abs(draft.startTime - session.initialStartTime) > RESIZE_SYNC_EPSILON_SECONDS
        || Math.abs(draft.endTime - session.initialEndTime) > RESIZE_SYNC_EPSILON_SECONDS
      )
      if (!didChange || !onAnnotationResize) {
        setAnnotationResizeDraft(null)
        return
      }

      Promise.resolve(
        onAnnotationResize(session.annotationId, {
          startTime: draft.startTime,
          endTime: draft.endTime
        })
      )
        .then(() => {
          setAnnotationResizeDraft((current) => {
            if (!current) return null
            const sameDraft = (
              current.annotationId === draft.annotationId
              && Math.abs(current.startTime - draft.startTime) <= RESIZE_SYNC_EPSILON_SECONDS
              && Math.abs(current.endTime - draft.endTime) <= RESIZE_SYNC_EPSILON_SECONDS
            )
            return sameDraft ? null : current
          })
        })
        .catch((error) => {
          console.error('Failed to resize annotation:', error)
          setAnnotationResizeDraft((current) => {
            if (!current) return null
            const sameDraft = (
              current.annotationId === draft.annotationId
              && Math.abs(current.startTime - draft.startTime) <= RESIZE_SYNC_EPSILON_SECONDS
              && Math.abs(current.endTime - draft.endTime) <= RESIZE_SYNC_EPSILON_SECONDS
            )
            return sameDraft ? null : current
          })
        })
    }

    const handlePointerUp = () => {
      stopResizing(true)
    }

    const handlePointerCancel = () => {
      stopResizing(false)
    }

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
  }, [isResizingAnnotation, onAnnotationResize])

  // Auto-scroll to follow playback position (only when snapToPlayback is true)
  useEffect(() => {
    if (!containerRef.current || !snapToPlayback || isResizingAnnotation) return

    const container = containerRef.current
    const playbackX = currentTime * configRef.current.pixelsPerTimeStep
    const containerWidth = container.clientWidth
    const scrollLeft = container.scrollLeft

    // Check if this is a seek (large jump in time)
    const timeDiff = Math.abs(currentTime - lastScrollTimeRef.current)
    const isSeek = timeDiff > 1 // More than 1 second difference = seek

    if (isSeek) {
      // On seek, center the position in viewport
      const targetScroll = playbackX - containerWidth / 2

      // Mark the time of programmatic scroll
      lastProgrammaticScrollRef.current = Date.now()

      // Clear any existing timeout
      if (programmaticScrollTimeoutRef.current) {
        clearTimeout(programmaticScrollTimeoutRef.current)
      }

      container.scrollTo({
        left: Math.max(0, targetScroll),
        behavior: 'smooth'
      })

      // Keep the flag set for duration of smooth scroll (1 second for seek)
      programmaticScrollTimeoutRef.current = setTimeout(() => {
        lastProgrammaticScrollRef.current = 0
      }, 1000)
    } else if (isPlaying) {
      // During playback, scroll if playback line is near the edge
      const rightEdge = scrollLeft + containerWidth
      const leftEdge = scrollLeft
      const margin = containerWidth * 0.2 // Start scrolling when 20% from edge

      if (playbackX > rightEdge - margin || (playbackX < leftEdge + margin && scrollLeft > 0)) {
        // Mark the time of programmatic scroll
        lastProgrammaticScrollRef.current = Date.now()

        // Clear any existing timeout
        if (programmaticScrollTimeoutRef.current) {
          clearTimeout(programmaticScrollTimeoutRef.current)
        }

        if (playbackX > rightEdge - margin) {
          // Scrolling right
          container.scrollTo({
            left: playbackX - containerWidth + margin,
            behavior: 'smooth'
          })
        } else {
          // Scrolling left
          container.scrollTo({
            left: playbackX - margin,
            behavior: 'smooth'
          })
        }

        // Keep the flag set for duration of smooth scroll (600ms for playback)
        programmaticScrollTimeoutRef.current = setTimeout(() => {
          lastProgrammaticScrollRef.current = 0
        }, 600)
      }
    }

    lastScrollTimeRef.current = currentTime
  }, [currentTime, isPlaying, snapToPlayback, isResizingAnnotation])

  // Detect manual scrolling and disable snap mode
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleScroll = () => {
      // Check if this scroll happened recently after a programmatic scroll
      const timeSinceLastProgrammaticScroll = Date.now() - lastProgrammaticScrollRef.current
      const isProgrammaticScroll = timeSinceLastProgrammaticScroll < 1000

      // Only disable snap if this is a user-initiated scroll
      if (!isProgrammaticScroll && snapToPlayback) {
        onSnapToPlaybackChange?.(false)
      }
    }

    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [snapToPlayback, onSnapToPlaybackChange])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (programmaticScrollTimeoutRef.current) {
        clearTimeout(programmaticScrollTimeoutRef.current)
      }
    }
  }, [])

  // Handle mouse move for hover indicator
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || isAnnotationMode) return

    const rect = svgRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    setHoverX(x)
    const hoverTime = x / configRef.current.pixelsPerTimeStep
    const clampedTime = Math.max(0, Math.min(timelineTotalTime, hoverTime))
    onHoverTimeChange?.(clampedTime)
  }

  const handleMouseLeave = () => {
    setHoverX(null)
    onHoverTimeChange?.(null)
  }

  // Handle click on piano roll for seeking
  const handleSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (isAnnotationMode || !svgRef.current) return

    const rect = svgRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const rawTime = x / configRef.current.pixelsPerTimeStep
    const time = Math.max(0, Math.min(timelineTotalTime, rawTime))

    // Enable snap mode when clicking to seek
    onSnapToPlaybackChange?.(true)
    onTimeClick?.(time)
  }

  const handleAnnotationResizePointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    annotation: Annotation,
    edge: AnnotationResizeEdge
  ) => {
    if (isAnnotationMode) return
    event.preventDefault()
    event.stopPropagation()

    resizeSessionRef.current = {
      annotationId: annotation.id,
      edge,
      startClientX: event.clientX,
      initialStartTime: annotation.start_time,
      initialEndTime: annotation.end_time
    }
    setAnnotationResizeDraft({
      annotationId: annotation.id,
      startTime: annotation.start_time,
      endTime: annotation.end_time
    })
    setIsResizingAnnotation(true)
  }

  const pixelsPerTimeStep = configRef.current.pixelsPerTimeStep
  if (!sequence) {
    return (
      <div className="text-center py-8 text-gray-500">
        <p>No MIDI sequence loaded</p>
      </div>
    )
  }
  const timelineWidth = Math.max(1, Math.ceil(timelineTotalTime * pixelsPerTimeStep))

  return (
    <div
      ref={containerRef}
      className={`overflow-x-auto overflow-y-hidden border rounded relative ${
        isAnnotationMode ? 'cursor-crosshair' : 'cursor-pointer'
      }`}
    >
      <div className="relative" style={{ minWidth: `${timelineWidth}px` }}>
        <div className="relative">
          {/* Annotation overlays positioned behind SVG */}
          {displayedAnnotations.length > 0 && visualizerRef.current && (
            <div className="absolute top-0 left-0 pointer-events-none z-0">
              {displayedAnnotations.map((annotation) => {
                const startX = annotation.start_time * pixelsPerTimeStep
                const width = (annotation.end_time - annotation.start_time) * pixelsPerTimeStep
                const color = stringToColor(annotation.song_name)

                return (
                  <div
                    key={annotation.id}
                    className="absolute opacity-30"
                    style={{
                      left: `${startX}px`,
                      width: `${width}px`,
                      backgroundColor: color,
                      top: 0,
                      height: '100%'
                    }}
                    title={`${annotation.song_name} (${annotation.start_time.toFixed(1)}s - ${annotation.end_time.toFixed(1)}s)`}
                  />
                )
              })}
            </div>
          )}

          {/* Selection overlay during drag */}
          {dragState.isDragging && (
            <div
              className="absolute pointer-events-none bg-blue-500 opacity-30 z-10"
              style={{
                left: `${Math.min(dragState.startX, dragState.currentX)}px`,
                width: `${Math.abs(dragState.currentX - dragState.startX)}px`,
                top: 0,
                height: '100%'
              }}
            />
          )}

          {/* Playback position line - shown when playing */}
          {isPlaying && (
            <div
              className="absolute pointer-events-none z-20"
              style={{
                left: `${currentTime * pixelsPerTimeStep}px`,
                top: 0,
                bottom: 0,
                width: '3px',
                backgroundColor: 'rgba(230, 100, 101, 0.8)', // Theme color #E66465
                boxShadow: '0 0 6px rgba(230, 100, 101, 0.5)'
              }}
            >
              {/* Triangle indicator at top */}
              <div
                className="absolute"
                style={{
                  top: '-8px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: 0,
                  height: 0,
                  borderLeft: '6px solid transparent',
                  borderRight: '6px solid transparent',
                  borderTop: '8px solid rgba(230, 100, 101, 0.8)'
                }}
              />
            </div>
          )}

          {/* Start checkpoint marker */}
          {startCheckpoint !== null && (
            <div
              className="absolute pointer-events-none z-20"
              style={{
                left: `${startCheckpoint * pixelsPerTimeStep}px`,
                top: 0,
                bottom: 0,
                width: '3px',
                backgroundColor: 'rgba(34, 197, 94, 0.7)', // Green
                boxShadow: '0 0 6px rgba(34, 197, 94, 0.5)'
              }}
            >
              {/* Flag indicator at top */}
              <div
                className="absolute bg-green-500 text-white text-xs px-1 rounded"
                style={{
                  top: '-20px',
                  left: '5px',
                  fontSize: '10px',
                  whiteSpace: 'nowrap'
                }}
              >
                Start
              </div>
            </div>
          )}

          {/* End checkpoint marker */}
          {endCheckpoint !== null && (
            <div
              className="absolute pointer-events-none z-20"
              style={{
                left: `${endCheckpoint * pixelsPerTimeStep}px`,
                top: 0,
                bottom: 0,
                width: '3px',
                backgroundColor: 'rgba(239, 68, 68, 0.7)', // Red
                boxShadow: '0 0 6px rgba(239, 68, 68, 0.5)'
              }}
            >
              {/* Flag indicator at top */}
              <div
                className="absolute bg-red-500 text-white text-xs px-1 rounded"
                style={{
                  top: '-20px',
                  left: '5px',
                  fontSize: '10px',
                  whiteSpace: 'nowrap'
                }}
              >
                End
              </div>
            </div>
          )}

          {/* Hover line indicator - only shown when not playing */}
          {hoverX !== null && !isAnnotationMode && !isPlaying && (
            <div
              className="absolute pointer-events-none z-20"
              style={{
                left: `${hoverX}px`,
                top: 0,
                bottom: 0,
                width: '2px',
                backgroundColor: 'rgba(145, 152, 229, 0.5)',
                boxShadow: '0 0 4px rgba(145, 152, 229, 0.3)'
              }}
            />
          )}

          <div
            className="relative z-5"
            onMouseLeave={handleMouseLeave}
          >
            <svg
              ref={svgRef}
              onClick={handleSvgClick}
              className="block"
              {...(isAnnotationMode
                ? handlers
                : { onMouseMove: handleMouseMove }
              )}
            />
          </div>
        </div>

        <div className="relative h-12 border-t bg-gray-50">
          {displayedAnnotations.length === 0 ? (
            <div className="absolute inset-0 flex items-center px-3 text-xs text-gray-400">
              No annotations yet
            </div>
          ) : (
            displayedAnnotations.map((annotation) => {
              const startX = annotation.start_time * pixelsPerTimeStep
              const rawWidth = (annotation.end_time - annotation.start_time) * pixelsPerTimeStep
              const width = Math.max(30, rawWidth)
              const backgroundColor = stringToTimelineColor(annotation.song_name)
              const color = stringToTextColor(annotation.song_name)
              const labelOffsets = buildRepeatingLabelOffsets(width)
              const isResizingThisAnnotation = annotationResizeDraft?.annotationId === annotation.id
              const handleClasses = isResizingThisAnnotation
                ? 'opacity-100'
                : 'opacity-60 group-hover:opacity-100'

              return (
                <div
                  key={`timeline-${annotation.id}`}
                  className="absolute top-2 h-8 group"
                  style={{
                    left: `${startX}px`,
                    width: `${width}px`
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onSnapToPlaybackChange?.(true)
                      onTimeClick?.(annotation.start_time)
                    }}
                    className="h-full w-full rounded border border-black/10 text-xs font-semibold text-left overflow-hidden shadow-sm hover:brightness-95 transition-[filter]"
                    style={{
                      backgroundColor,
                      color
                    }}
                    aria-label={`${annotation.song_name} (${annotation.start_time.toFixed(1)} to ${annotation.end_time.toFixed(1)} seconds)`}
                    title={`${annotation.song_name} (${annotation.start_time.toFixed(1)}s - ${annotation.end_time.toFixed(1)}s)`}
                  >
                    {labelOffsets.map((offset) => (
                      <span
                        key={`${annotation.id}-${offset}`}
                        className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap pointer-events-none"
                        style={{ left: `${offset}px` }}
                      >
                        {annotation.song_name}
                      </span>
                    ))}
                  </button>
                  {onAnnotationDelete && labelOffsets.map((offset) => (
                    <div
                      key={`delete-${annotation.id}-${offset}`}
                      className="absolute top-1/2 -translate-y-1/2 pointer-events-none"
                      style={{ left: `${offset + getDeleteButtonOffset(annotation.song_name)}px` }}
                    >
                      <button
                        type="button"
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          onAnnotationDelete(annotation.id)
                        }}
                        aria-label={`Delete annotation ${annotation.song_name}`}
                        title={`Delete annotation: ${annotation.song_name}`}
                        className="pointer-events-auto h-4 w-4 rounded-full bg-red-600/90 text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 flex items-center justify-center"
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onPointerDown={(event) => handleAnnotationResizePointerDown(event, annotation, 'start')}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                    }}
                    disabled={isAnnotationMode}
                    aria-label={`Resize start for ${annotation.song_name}`}
                    className={`absolute left-0 top-0 h-full w-2.5 cursor-ew-resize flex items-center justify-center rounded-l transition-opacity ${handleClasses}`}
                    title="Drag to adjust start time"
                  >
                    <span className="pointer-events-none block h-4 w-[2px] rounded-full bg-black/40" />
                  </button>
                  <button
                    type="button"
                    onPointerDown={(event) => handleAnnotationResizePointerDown(event, annotation, 'end')}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                    }}
                    disabled={isAnnotationMode}
                    aria-label={`Resize end for ${annotation.song_name}`}
                    className={`absolute right-0 top-0 h-full w-2.5 cursor-ew-resize flex items-center justify-center rounded-r transition-opacity ${handleClasses}`}
                    title="Drag to adjust end time"
                  >
                    <span className="pointer-events-none block h-4 w-[2px] rounded-full bg-black/40" />
                  </button>
                </div>
              )
            })
          )}
        </div>
        <div className="relative h-12 border-t bg-sky-50/50">
          {predictions.length === 0 ? (
            <div className="absolute inset-0 flex items-center px-3 text-xs text-sky-700/60">
              No predictions
            </div>
          ) : (
            predictions.map((prediction) => {
              const startX = prediction.startTime * pixelsPerTimeStep
              const rawWidth = (prediction.endTime - prediction.startTime) * pixelsPerTimeStep
              const width = Math.max(22, rawWidth)
              const backgroundColor = stringToPredictionTimelineColor(prediction.songName, prediction.confidence)
              const color = stringToTextColor(prediction.songName)
              const labelOffsets = buildRepeatingLabelOffsets(width)
              const confidencePct = prediction.confidence !== null
                ? `${Math.round(prediction.confidence * 100)}%`
                : null

              return (
                <button
                  key={`prediction-timeline-${prediction.id}`}
                  type="button"
                  onClick={() => {
                    if (onPredictionClick) {
                      onPredictionClick(prediction.id)
                      return
                    }
                    onSnapToPlaybackChange?.(true)
                    onTimeClick?.(prediction.startTime)
                  }}
                  className="absolute top-2 h-8 rounded border border-sky-500/40 text-xs font-semibold text-left overflow-hidden shadow-sm hover:brightness-95 transition-[filter]"
                  style={{
                    left: `${startX}px`,
                    width: `${width}px`,
                    backgroundColor,
                    color
                  }}
                  aria-label={`Predicted ${prediction.songName} (${prediction.startTime.toFixed(1)} to ${prediction.endTime.toFixed(1)} seconds)${
                    confidencePct ? ` at ${confidencePct}` : ''
                  }`}
                  title={`Predicted ${prediction.songName}${confidencePct ? ` (${confidencePct})` : ''} (${prediction.startTime.toFixed(1)}s - ${prediction.endTime.toFixed(1)}s)`}
                >
                  {labelOffsets.map((offset) => (
                    <span
                      key={`${prediction.id}-${offset}`}
                      className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap pointer-events-none"
                      style={{ left: `${offset}px` }}
                    >
                      {prediction.songName}{confidencePct ? ` ${confidencePct}` : ''}
                    </span>
                  ))}
                </button>
              )
            })
          )}
        </div>
        <div className="relative h-10 border-t bg-gray-100/70">
          {ignoredSections.length === 0 ? (
            <div className="absolute inset-0 flex items-center px-3 text-xs text-gray-500">
              No ignored sections
            </div>
          ) : (
            ignoredSections.map((ignoredSection) => {
              const startX = ignoredSection.startTime * pixelsPerTimeStep
              const rawWidth = (ignoredSection.endTime - ignoredSection.startTime) * pixelsPerTimeStep
              const width = Math.max(28, rawWidth)
              const labelOffsets = buildRepeatingLabelOffsets(width)
              const label = ignoredSection.reason?.trim()
                ? `Ignored: ${ignoredSection.reason}`
                : 'Ignored'

              return (
                <button
                  key={`ignored-timeline-${ignoredSection.id}`}
                  type="button"
                  onClick={() => {
                    if (onIgnoredSectionClick) {
                      onIgnoredSectionClick(ignoredSection.id)
                      return
                    }
                    onSnapToPlaybackChange?.(true)
                    onTimeClick?.(ignoredSection.startTime)
                  }}
                  className="absolute top-1 h-8 rounded border border-gray-500/40 bg-gray-300/70 text-[11px] font-semibold text-gray-900 text-left overflow-hidden shadow-sm hover:brightness-95 transition-[filter]"
                  style={{
                    left: `${startX}px`,
                    width: `${width}px`
                  }}
                  aria-label={`${label} (${ignoredSection.startTime.toFixed(1)} to ${ignoredSection.endTime.toFixed(1)} seconds)`}
                  title={`${label} (${ignoredSection.startTime.toFixed(1)}s - ${ignoredSection.endTime.toFixed(1)}s)`}
                >
                  {labelOffsets.map((offset) => (
                    <span
                      key={`${ignoredSection.id}-${offset}`}
                      className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap pointer-events-none"
                      style={{ left: `${offset}px` }}
                    >
                      {label}
                    </span>
                  ))}
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

// Hash string to color for consistent annotation colors
function stringToColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }

  const hue = hash % 360
  return `hsl(${hue}, 70%, 60%)`
}

function stringToTextColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }

  const hue = hash % 360
  return `hsl(${hue}, 80%, 20%)`
}

function stringToTimelineColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }

  const hue = hash % 360
  return `hsla(${hue}, 70%, 62%, 0.7)`
}

function stringToPredictionTimelineColor(str: string, confidence: number | null): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }

  const hue = hash % 360
  const safeConfidence = confidence === null
    ? 0.5
    : Math.min(1, Math.max(0, confidence))
  const alpha = 0.25 + (safeConfidence * 0.45)
  return `hsla(${hue}, 75%, 65%, ${alpha.toFixed(2)})`
}

function buildRepeatingLabelOffsets(widthPx: number): number[] {
  const offsets: number[] = []
  const startOffset = 8
  const repeatGap = 1000

  for (let offset = startOffset; offset < widthPx; offset += repeatGap) {
    offsets.push(offset)
  }

  if (offsets.length === 0) {
    offsets.push(startOffset)
  }

  return offsets
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function roundToMillis(value: number): number {
  return Math.round(value * 1000) / 1000
}

function getDeleteButtonOffset(label: string): number {
  return Math.max(28, (label.length * 6.5) + 12)
}
