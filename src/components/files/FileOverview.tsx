import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { stringToTimelineColor } from '../midi/pianoRollColors'
import { candidateCountLabel, candidateSpans, type CandidateRun } from './predictionCandidates'
import type { RollAnnotation, RollPrediction } from '../midi/pianoRollTypes'
import { useAnnotationResize } from '@/hooks/useAnnotationResize'
import type { AnnotationResizeEdge } from '../midi/PianoRollTimelines'

/**
 * Minimum rendered width for a resizable annotation span. The two resize
 * handles sit at the edges; below this width they would overlap into a single
 * grabbable dot and the user could not tell start from end.
 */
const MIN_RESIZE_SPAN_PX = 28

/**
 * The whole recording on one line per layer.
 *
 * The piano roll shows a scrolling window at note resolution; this is the other
 * end of that scale — the entire file at a glance, so the shape of a session is
 * readable without scrolling and any song is one click away.
 *
 * `SpanRow` and `TimelineBar` are shared with the Prediction Lab, which stacks
 * candidate runs against these same rows. Every row is drawn against the same
 * `durationSec`, which is what makes them comparable by eye.
 */

export interface OverviewSpan {
  key: string
  label: string
  start: number
  end: number
}

export const SpanRow = memo(function SpanRow({ spans, durationSec, onSeek, emptyLabel, minSpanPercent = 0.4, onResizePointerDown, resizingKey, containerRef }: {
  spans: OverviewSpan[]
  durationSec: number
  onSeek: (time: number) => void
  emptyLabel?: string
  /** Floor on the rendered width, so sub-second spans stay hittable/grabbable. */
  minSpanPercent?: number
  onResizePointerDown?: (event: React.PointerEvent<HTMLButtonElement>, span: OverviewSpan, edge: AnnotationResizeEdge) => void
  resizingKey?: string | null
  containerRef?: React.Ref<HTMLDivElement>
}) {
  if (durationSec <= 0) return null
  return (
    <div ref={containerRef} className="relative h-7 bg-gray-100 rounded overflow-hidden">
      {spans.length === 0 && emptyLabel && (
        <span className="absolute inset-0 flex items-center px-2 text-xs text-gray-400">
          {emptyLabel}
        </span>
      )}
      {spans.map((span) => {
        const left = (span.start / durationSec) * 100
        // Sub-second spans still need to be clickable, so clamp the width. A
        // resizable row uses a wider floor so its start/end handles stay apart.
        const width = Math.max(minSpanPercent, ((span.end - span.start) / durationSec) * 100)
        const handleClasses = resizingKey === span.key ? 'opacity-100' : 'opacity-60 hover:opacity-100'
        return (
          <Fragment key={span.key}>
            <button
              type="button"
              onClick={() => onSeek(span.start)}
              title={`${span.label} — ${formatClock(span.start)} to ${formatClock(span.end)}`}
              className="absolute top-0 h-full border-r border-white/60 overflow-hidden text-[10px] leading-7 px-1 text-gray-900 whitespace-nowrap hover:brightness-95"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                backgroundColor: stringToTimelineColor(span.label)
              }}
            >
              {span.label}
            </button>
            {onResizePointerDown && (
              <>
                <button
                  type="button"
                  onPointerDown={(event) => onResizePointerDown(event, span, 'start')}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  aria-label={`Resize start of ${span.label}`}
                  className={`absolute inset-y-0 w-2.5 -translate-x-1/2 cursor-ew-resize flex items-center justify-center rounded-l transition-opacity ${handleClasses}`}
                  style={{ left: `${left}%` }}
                  title="Drag to adjust start time"
                >
                  <span className="pointer-events-none block h-4 w-[2px] rounded-full bg-black/40" />
                </button>
                <button
                  type="button"
                  onPointerDown={(event) => onResizePointerDown(event, span, 'end')}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  aria-label={`Resize end of ${span.label}`}
                  className={`absolute inset-y-0 w-2.5 -translate-x-1/2 cursor-ew-resize flex items-center justify-center rounded-r transition-opacity ${handleClasses}`}
                  style={{ left: `${left + width}%` }}
                  title="Drag to adjust end time"
                >
                  <span className="pointer-events-none block h-4 w-[2px] rounded-full bg-black/40" />
                </button>
              </>
            )}
          </Fragment>
        )
      })}
    </div>
  )
})

/**
 * The playhead is a sibling of `SpanRow`, never a prop of it.
 *
 * `currentTime` changes every frame during playback. Threading it through the
 * memoised row would re-render every span in the file on every frame — the same
 * mistake `PianoRollTimelines` is written to avoid. As an overlay, only this one
 * absolutely-positioned line updates.
 */
const Playhead = memo(function Playhead({ currentTime, durationSec }: {
  currentTime: number
  durationSec: number
}) {
  if (durationSec <= 0 || currentTime < 0 || currentTime > durationSec) return null
  return (
    <div
      aria-hidden
      data-testid="overview-playhead"
      className="pointer-events-none absolute inset-y-0 w-0.5 -ml-px bg-red-500/90"
      style={{ left: `${(currentTime / durationSec) * 100}%` }}
    />
  )
})

/** A labelled row with the playhead drawn over it. */
export function TimelineBar({
  label, detail, spans, durationSec, currentTime, onSeek, emptyLabel, trailing, minSpanPercent, onResizePointerDown, resizingKey, containerRef
}: {
  label: string
  detail?: string
  spans: OverviewSpan[]
  durationSec: number
  currentTime?: number
  onSeek: (time: number) => void
  emptyLabel?: string
  trailing?: React.ReactNode
  minSpanPercent?: number
  onResizePointerDown?: (event: React.PointerEvent<HTMLButtonElement>, span: OverviewSpan, edge: AnnotationResizeEdge) => void
  resizingKey?: string | null
  containerRef?: React.Ref<HTMLDivElement>
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="text-[11px] text-gray-600 truncate">
          {label}
          {detail && <span className="text-gray-400"> · {detail}</span>}
        </div>
        {trailing && <div className="flex items-center gap-1 shrink-0">{trailing}</div>}
      </div>
      <div className="relative">
        <SpanRow
          spans={spans}
          durationSec={durationSec}
          onSeek={onSeek}
          emptyLabel={emptyLabel}
          minSpanPercent={minSpanPercent}
          onResizePointerDown={onResizePointerDown}
          resizingKey={resizingKey}
          containerRef={containerRef}
        />
        {currentTime !== undefined && (
          <Playhead currentTime={currentTime} durationSec={durationSec} />
        )}
      </div>
    </div>
  )
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

/** Evenly spaced clock labels, so a position on the bar means something. */
function TimeAxis({ durationSec }: { durationSec: number }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  return (
    <div className="relative h-4 mt-1">
      {ticks.map((fraction) => (
        <span
          key={fraction}
          className="absolute top-0 text-[10px] text-gray-400 tabular-nums"
          style={{
            left: `${fraction * 100}%`,
            transform: fraction === 0 ? 'none' : fraction === 1 ? 'translateX(-100%)' : 'translateX(-50%)'
          }}
        >
          {formatClock(durationSec * fraction)}
        </span>
      ))}
    </div>
  )
}

interface FileOverviewProps {
  durationSec: number
  currentTime: number
  annotations: RollAnnotation[]
  predictions: RollPrediction[]
  /** Previewed runs from the Prediction Lab, drawn against the same axis. */
  candidates?: CandidateRun[]
  isFileComplete?: boolean
  onSeek: (time: number) => void
  onAnnotationResize?: (
    annotationId: number,
    times: { startTime: number; endTime: number }
  ) => void | Promise<void>
}

export function FileOverview({
  durationSec, currentTime, annotations, predictions, candidates = [], isFileComplete = false, onSeek, onAnnotationResize
}: FileOverviewProps) {
  // The resize drag works in pixels, but these rows are laid out in percent, so
  // the conversion has to go through the measured width of the annotation bar.
  const annotationRowRef = useRef<HTMLDivElement | null>(null)
  const [annotationRowWidth, setAnnotationRowWidth] = useState(0)

  useEffect(() => {
    const el = annotationRowRef.current
    if (!el) return
    const update = () => setAnnotationRowWidth(el.getBoundingClientRect().width)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pixelsPerTimeStep = durationSec > 0 && annotationRowWidth > 0
    ? annotationRowWidth / durationSec
    : 1
  const annotationMinPercent = annotationRowWidth > 0
    ? Math.min(100, (MIN_RESIZE_SPAN_PX / annotationRowWidth) * 100)
    : 0.4

  const {
    displayedAnnotations,
    resizingAnnotationId,
    handleResizePointerDown
  } = useAnnotationResize({
    annotations,
    pixelsPerTimeStep,
    onAnnotationResize
  })

  const annotationByKey = useMemo(() => {
    const map = new Map<string, RollAnnotation>()
    for (const annotation of displayedAnnotations) {
      map.set(`overview-annotation-${annotation.id}`, annotation)
    }
    return map
  }, [displayedAnnotations])

  const handleSpanResizePointerDown = useCallback((
    event: React.PointerEvent<HTMLButtonElement>,
    span: OverviewSpan,
    edge: AnnotationResizeEdge
  ) => {
    const annotation = annotationByKey.get(span.key)
    if (annotation) handleResizePointerDown(event, annotation, edge)
  }, [annotationByKey, handleResizePointerDown])

  const resizingKey = resizingAnnotationId !== null
    ? `overview-annotation-${resizingAnnotationId}`
    : null

  if (durationSec <= 0) return null
  if (annotations.length === 0 && predictions.length === 0 && candidates.length === 0) return null

  return (
    <div className="mt-4 pt-4 border-t space-y-2">
      <div className="text-xs font-semibold text-gray-700">
        Whole recording <span className="font-normal text-gray-500">· click a span to jump there, drag its edges to resize</span>
      </div>

      <TimelineBar
        label={`Annotations (${annotations.length})`}
        durationSec={durationSec}
        currentTime={currentTime}
        onSeek={onSeek}
        emptyLabel="No annotations yet"
        containerRef={annotationRowRef}
        minSpanPercent={annotationMinPercent}
        onResizePointerDown={handleSpanResizePointerDown}
        resizingKey={resizingKey}
        spans={displayedAnnotations.map((annotation) => ({
          key: `overview-annotation-${annotation.id}`,
          label: annotation.song_name,
          start: annotation.start_time,
          end: annotation.end_time
        }))}
      />

      {predictions.length > 0 && (
        <TimelineBar
          label={`Predictions (${predictions.length})`}
          durationSec={durationSec}
          currentTime={currentTime}
          onSeek={onSeek}
          spans={predictions.map((prediction) => ({
            key: `overview-prediction-${prediction.id}`,
            label: prediction.songName,
            start: prediction.startTime,
            end: prediction.endTime
          }))}
        />
      )}

      {candidates.map((run) => (
        <TimelineBar
          key={`overview-candidate-${run.id}`}
          label={`Candidate ${run.id}: ${run.label}`}
          detail={candidateCountLabel(run, isFileComplete)}
          durationSec={durationSec}
          currentTime={currentTime}
          onSeek={onSeek}
          spans={candidateSpans(run, isFileComplete)}
        />
      ))}

      <TimeAxis durationSec={durationSec} />
    </div>
  )
}
