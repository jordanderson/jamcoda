import { memo } from 'react'
import { stringToTimelineColor } from '../midi/pianoRollColors'
import { candidateCountLabel, candidateSpans, type CandidateRun } from './predictionCandidates'
import type { RollAnnotation, RollPrediction } from '../midi/pianoRollTypes'

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

export const SpanRow = memo(function SpanRow({ spans, durationSec, onSeek, emptyLabel }: {
  spans: OverviewSpan[]
  durationSec: number
  onSeek: (time: number) => void
  emptyLabel?: string
}) {
  if (durationSec <= 0) return null
  return (
    <div className="relative h-7 bg-gray-100 rounded overflow-hidden">
      {spans.length === 0 && emptyLabel && (
        <span className="absolute inset-0 flex items-center px-2 text-xs text-gray-400">
          {emptyLabel}
        </span>
      )}
      {spans.map((span) => {
        const left = (span.start / durationSec) * 100
        // Sub-second spans still need to be clickable, so clamp the width.
        const width = Math.max(0.4, ((span.end - span.start) / durationSec) * 100)
        return (
          <button
            key={span.key}
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
  label, detail, spans, durationSec, currentTime, onSeek, emptyLabel, trailing
}: {
  label: string
  detail?: string
  spans: OverviewSpan[]
  durationSec: number
  currentTime?: number
  onSeek: (time: number) => void
  emptyLabel?: string
  trailing?: React.ReactNode
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
        <SpanRow spans={spans} durationSec={durationSec} onSeek={onSeek} emptyLabel={emptyLabel} />
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
}

export function FileOverview({
  durationSec, currentTime, annotations, predictions, candidates = [], isFileComplete = false, onSeek
}: FileOverviewProps) {
  if (durationSec <= 0) return null
  if (annotations.length === 0 && predictions.length === 0 && candidates.length === 0) return null

  return (
    <div className="mt-4 pt-4 border-t space-y-2">
      <div className="text-xs font-semibold text-gray-700">
        Whole recording <span className="font-normal text-gray-500">· click a span to jump there</span>
      </div>

      <TimelineBar
        label={`Annotations (${annotations.length})`}
        durationSec={durationSec}
        currentTime={currentTime}
        onSeek={onSeek}
        emptyLabel="No annotations yet"
        spans={annotations.map((annotation) => ({
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
