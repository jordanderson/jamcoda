import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAnnotationResize } from '@/hooks/useAnnotationResize'
import { usePianoRollFollow } from '@/hooks/usePianoRollFollow'
import { usePianoRollInteraction } from '@/hooks/usePianoRollInteraction'
import type { NoteSequence } from '@core/midi/noteSequence'
import { buildPianoRollLayout } from './pianoRollGeometry'
import { PianoRollNotes } from './PianoRollNotes'
import {
  AnnotationBands,
  CheckpointMarker,
  DeviceMarkerLayer,
  Playhead
} from './PianoRollOverlays'
import {
  AnnotationTimeline,
  IgnoredTimeline,
  PredictionTimeline,
  type AnnotationResizeEdge
} from './PianoRollTimelines'
import type {
  RollAnnotation,
  RollBookmark,
  RollIgnoredSection,
  RollPrediction,
  RollSkip
} from './pianoRollTypes'

interface PianoRollVisualizerProps {
  sequence: NoteSequence | null
  currentTime?: number
  isPlaying?: boolean
  annotations?: RollAnnotation[]
  predictions?: RollPrediction[]
  ignoredSections?: RollIgnoredSection[]
  bookmarks?: RollBookmark[]
  skips?: RollSkip[]
  /** Only render silence gaps at or above this many seconds (default 8). */
  minSkipDisplaySec?: number
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

/** Horizontal scale and note geometry. Fixed, so it lives outside the component. */
const ROLL_CONFIG = {
  pixelsPerTimeStep: 50,
  noteHeight: 3,
  noteSpacing: 1,
  noteRGB: '148, 152, 229' // Matches theme color #9198E5
} as const

const EMPTY_ANNOTATIONS: RollAnnotation[] = []
const EMPTY_PREDICTIONS: RollPrediction[] = []
const EMPTY_IGNORED: RollIgnoredSection[] = []
const EMPTY_BOOKMARKS: RollBookmark[] = []
const EMPTY_SKIPS: RollSkip[] = []

/**
 * The piano roll.
 *
 * Re-renders every animation frame during playback, since the playhead arrives
 * as a prop. Everything expensive therefore sits behind a `memo` boundary --
 * the notes, the three chip rows, the bands and the device markers -- so a
 * frame costs this small tree plus one repositioned `<div>`. Callers must pass
 * stable handlers for that to hold; `DetailPage` uses `useCallback` throughout.
 */
function PianoRollVisualizerImpl({
  sequence,
  currentTime = 0,
  isPlaying = false,
  annotations = EMPTY_ANNOTATIONS,
  predictions = EMPTY_PREDICTIONS,
  ignoredSections = EMPTY_IGNORED,
  bookmarks = EMPTY_BOOKMARKS,
  skips = EMPTY_SKIPS,
  minSkipDisplaySec = 8,
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
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [hoverX, setHoverX] = useState<number | null>(null)

  const { pixelsPerTimeStep } = ROLL_CONFIG

  const {
    displayedAnnotations,
    resizingAnnotationId,
    isResizing,
    handleResizePointerDown
  } = useAnnotationResize({
    annotations,
    pixelsPerTimeStep,
    onAnnotationResize
  })

  const { dragState, handlers } = usePianoRollInteraction({
    svgRef,
    pixelsPerTimeStep,
    onRegionSelect,
    onTimeClick,
    isEnabled: isAnnotationMode
  })

  // Annotations and predictions can extend past the last note, and the
  // timeline has to be wide enough to reach them.
  const timelineTotalTime = useMemo(() => {
    let end = sequence?.totalTime ?? 0
    for (const annotation of displayedAnnotations) {
      if (annotation.end_time > end) end = annotation.end_time
    }
    for (const prediction of predictions) {
      if (prediction.endTime > end) end = prediction.endTime
    }
    for (const ignoredSection of ignoredSections) {
      if (ignoredSection.endTime > end) end = ignoredSection.endTime
    }
    return end
  }, [sequence, displayedAnnotations, predictions, ignoredSections])

  // Note geometry is derived from the active sequence and rendered as SVG
  // rects below, so it stays in sync without any imperative redraw step.
  const noteLayout = useMemo(
    () => buildPianoRollLayout(sequence?.notes ?? [], ROLL_CONFIG),
    [sequence]
  )

  const handleUserScroll = useCallback(() => {
    onSnapToPlaybackChange?.(false)
  }, [onSnapToPlaybackChange])

  usePianoRollFollow({
    container: scrollContainer,
    playheadX: currentTime * pixelsPerTimeStep,
    isPlaying,
    enabled: snapToPlayback,
    // Following would fight a drag that is itself changing the geometry.
    suspended: isResizing,
    onUserScroll: handleUserScroll
  })

  // A new file starts at the beginning, not at the previous file's offset.
  useEffect(() => {
    if (scrollContainer) scrollContainer.scrollLeft = 0
  }, [scrollContainer, sequence])

  // Otherwise a stale hover readout outlives the switch into region-select.
  useEffect(() => {
    if (!isAnnotationMode) return
    setHoverX(null)
    onHoverTimeChange?.(null)
  }, [isAnnotationMode, onHoverTimeChange])

  const clampToTimeline = useCallback((time: number) => (
    Math.max(0, Math.min(timelineTotalTime, time))
  ), [timelineTotalTime])

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || isAnnotationMode) return
    const x = e.clientX - svgRef.current.getBoundingClientRect().left
    setHoverX(x)
    onHoverTimeChange?.(clampToTimeline(x / pixelsPerTimeStep))
  }, [clampToTimeline, isAnnotationMode, onHoverTimeChange, pixelsPerTimeStep])

  const handleMouseLeave = useCallback(() => {
    setHoverX(null)
    onHoverTimeChange?.(null)
  }, [onHoverTimeChange])

  /** Seeking from inside the roll always re-engages follow. */
  const seekAndFollow = useCallback((time: number) => {
    onSnapToPlaybackChange?.(true)
    onTimeClick?.(time)
  }, [onSnapToPlaybackChange, onTimeClick])

  const handleSvgClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (isAnnotationMode || !svgRef.current) return
    const x = e.clientX - svgRef.current.getBoundingClientRect().left
    seekAndFollow(clampToTimeline(x / pixelsPerTimeStep))
  }, [clampToTimeline, isAnnotationMode, pixelsPerTimeStep, seekAndFollow])

  const handleAnnotationResizePointerDown = useCallback((
    event: React.PointerEvent<HTMLButtonElement>,
    annotation: RollAnnotation,
    edge: AnnotationResizeEdge
  ) => {
    if (isAnnotationMode) return
    handleResizePointerDown(event, annotation, edge)
  }, [handleResizePointerDown, isAnnotationMode])

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
      ref={setScrollContainer}
      data-testid="piano-roll-scroll"
      className={`overflow-x-auto overflow-y-hidden border rounded relative ${
        isAnnotationMode ? 'cursor-crosshair' : 'cursor-pointer'
      }`}
    >
      <div className="relative" style={{ minWidth: `${timelineWidth}px` }}>
        <div className="relative">
          <AnnotationBands
            annotations={displayedAnnotations}
            pixelsPerTimeStep={pixelsPerTimeStep}
            hasNotes={noteLayout.rects.length > 0}
          />

          <DeviceMarkerLayer
            bookmarks={bookmarks}
            skips={skips}
            minSkipDisplaySec={minSkipDisplaySec}
            pixelsPerTimeStep={pixelsPerTimeStep}
          />

          {/* Selection overlay during a region drag */}
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

          <Playhead x={currentTime * pixelsPerTimeStep} isPlaying={isPlaying} />

          {startCheckpoint !== null && (
            <CheckpointMarker x={startCheckpoint * pixelsPerTimeStep} edge="start" />
          )}
          {endCheckpoint !== null && (
            <CheckpointMarker x={endCheckpoint * pixelsPerTimeStep} edge="end" />
          )}

          {/* Hover line, suppressed while the playhead is the thing to watch */}
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

          <div className="relative z-5" onMouseLeave={handleMouseLeave}>
            <svg
              ref={svgRef}
              onClick={handleSvgClick}
              className="block"
              width={timelineWidth}
              height={noteLayout.height}
              {...(isAnnotationMode ? handlers : { onMouseMove: handleMouseMove })}
            >
              <PianoRollNotes rects={noteLayout.rects} />
            </svg>
          </div>
        </div>

        <div className="relative h-12 border-t bg-gray-50">
          <AnnotationTimeline
            annotations={displayedAnnotations}
            pixelsPerTimeStep={pixelsPerTimeStep}
            resizingAnnotationId={resizingAnnotationId}
            isAnnotationMode={isAnnotationMode}
            onSeek={seekAndFollow}
            onDelete={onAnnotationDelete}
            onResizePointerDown={handleAnnotationResizePointerDown}
          />
        </div>

        <div className="relative h-12 border-t bg-sky-50/50">
          <PredictionTimeline
            predictions={predictions}
            pixelsPerTimeStep={pixelsPerTimeStep}
            onPredictionClick={onPredictionClick}
            onSeek={seekAndFollow}
          />
        </div>

        <div className="relative h-10 border-t bg-gray-100/70">
          <IgnoredTimeline
            ignoredSections={ignoredSections}
            pixelsPerTimeStep={pixelsPerTimeStep}
            onIgnoredSectionClick={onIgnoredSectionClick}
            onSeek={seekAndFollow}
          />
        </div>
      </div>
    </div>
  )
}

export const PianoRollVisualizer = memo(PianoRollVisualizerImpl)
