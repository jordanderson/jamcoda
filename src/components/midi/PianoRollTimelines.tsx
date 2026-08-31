import { memo } from 'react'
import { Trash2 } from 'lucide-react'
import {
  buildRepeatingLabelOffsets,
  getDeleteButtonOffset,
  stringToPredictionTimelineColor,
  stringToTextColor,
  stringToTimelineColor
} from './pianoRollColors'
import type { RollAnnotation, RollIgnoredSection, RollPrediction } from './pianoRollTypes'

/**
 * The three chip rows below the notes: annotations, predictions and ignored
 * sections.
 *
 * Each row is `memo`'d. A chip repeats its label once per 1000px, plus resize
 * handles and a delete button per label for annotations, and none of it
 * depends on the playhead -- so keeping it out of the per-frame render is what
 * stops playback stuttering on a long recording.
 */

export type AnnotationResizeEdge = 'start' | 'end'

interface AnnotationTimelineProps {
  annotations: RollAnnotation[]
  pixelsPerTimeStep: number
  /** The annotation currently being dragged, so its handles stay visible. */
  resizingAnnotationId: number | null
  /** Resize handles are meaningless while a region drag owns the pointer. */
  isAnnotationMode: boolean
  onSeek: (time: number) => void
  onDelete?: (annotationId: number) => void
  onResizePointerDown: (
    event: React.PointerEvent<HTMLButtonElement>,
    annotation: RollAnnotation,
    edge: AnnotationResizeEdge
  ) => void
}

export const AnnotationTimeline = memo(function AnnotationTimeline({
  annotations,
  pixelsPerTimeStep,
  resizingAnnotationId,
  isAnnotationMode,
  onSeek,
  onDelete,
  onResizePointerDown
}: AnnotationTimelineProps) {
  if (annotations.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center px-3 text-xs text-gray-400">
        No annotations yet
      </div>
    )
  }

  return (
    <>
      {annotations.map((annotation) => {
        const startX = annotation.start_time * pixelsPerTimeStep
        const width = Math.max(30, (annotation.end_time - annotation.start_time) * pixelsPerTimeStep)
        const labelOffsets = buildRepeatingLabelOffsets(width)
        const handleClasses = resizingAnnotationId === annotation.id
          ? 'opacity-100'
          : 'opacity-60 group-hover:opacity-100'

        return (
          <div
            key={`timeline-${annotation.id}`}
            className="absolute top-2 h-8 group"
            style={{ left: `${startX}px`, width: `${width}px` }}
          >
            <button
              type="button"
              onClick={() => onSeek(annotation.start_time)}
              className="h-full w-full rounded border border-black/10 text-xs font-semibold text-left overflow-hidden shadow-sm hover:brightness-95 transition-[filter]"
              style={{
                backgroundColor: stringToTimelineColor(annotation.song_name),
                color: stringToTextColor(annotation.song_name)
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
            {onDelete && labelOffsets.map((offset) => (
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
                    onDelete(annotation.id)
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
              onPointerDown={(event) => onResizePointerDown(event, annotation, 'start')}
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
              onPointerDown={(event) => onResizePointerDown(event, annotation, 'end')}
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
      })}
    </>
  )
})

interface PredictionTimelineProps {
  predictions: RollPrediction[]
  pixelsPerTimeStep: number
  onPredictionClick?: (predictionId: number) => void
  onSeek: (time: number) => void
}

export const PredictionTimeline = memo(function PredictionTimeline({
  predictions,
  pixelsPerTimeStep,
  onPredictionClick,
  onSeek
}: PredictionTimelineProps) {
  if (predictions.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center px-3 text-xs text-sky-700/60">
        No predictions
      </div>
    )
  }

  return (
    <>
      {predictions.map((prediction) => {
        const startX = prediction.startTime * pixelsPerTimeStep
        const width = Math.max(22, (prediction.endTime - prediction.startTime) * pixelsPerTimeStep)
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
              onSeek(prediction.startTime)
            }}
            className="absolute top-2 h-8 rounded border border-sky-500/40 text-xs font-semibold text-left overflow-hidden shadow-sm hover:brightness-95 transition-[filter]"
            style={{
              left: `${startX}px`,
              width: `${width}px`,
              backgroundColor: stringToPredictionTimelineColor(prediction.songName, prediction.confidence),
              color: stringToTextColor(prediction.songName)
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
      })}
    </>
  )
})

interface IgnoredTimelineProps {
  ignoredSections: RollIgnoredSection[]
  pixelsPerTimeStep: number
  onIgnoredSectionClick?: (ignoredSectionId: number) => void
  onSeek: (time: number) => void
}

export const IgnoredTimeline = memo(function IgnoredTimeline({
  ignoredSections,
  pixelsPerTimeStep,
  onIgnoredSectionClick,
  onSeek
}: IgnoredTimelineProps) {
  if (ignoredSections.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center px-3 text-xs text-gray-500">
        No ignored sections
      </div>
    )
  }

  return (
    <>
      {ignoredSections.map((ignoredSection) => {
        const startX = ignoredSection.startTime * pixelsPerTimeStep
        const width = Math.max(28, (ignoredSection.endTime - ignoredSection.startTime) * pixelsPerTimeStep)
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
              onSeek(ignoredSection.startTime)
            }}
            className="absolute top-1 h-8 rounded border border-gray-500/40 bg-gray-300/70 text-[11px] font-semibold text-gray-900 text-left overflow-hidden shadow-sm hover:brightness-95 transition-[filter]"
            style={{ left: `${startX}px`, width: `${width}px` }}
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
      })}
    </>
  )
})
