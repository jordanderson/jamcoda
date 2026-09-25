import { Check, Edit3, Headphones, Pause, Play, Scissors } from 'lucide-react'
import type { PredictionReview } from '@/api/localTypes'
import { resolveReviewFields } from '@core/predictionReview'
import { cutPieces, listenStretches, partsForReview } from '@core/predictionEvidence'
import type { TimeRange } from '@core/timeRanges'
import {
  BAND_DESCRIPTIONS,
  calibratedConfidence,
  type ConfidenceBand
} from '@core/predictionConfidence'
import { formatOrdinal, formatTime } from '@/utils/format'

/**
 * Listening to a flagged stretch plays this much before and after it and then
 * stops, so the way into it and out of it is heard as well as the stretch.
 */
const LISTEN_LEAD_IN_SEC = 3
const LISTEN_LEAD_OUT_SEC = 2

/** Badge color per calibrated confidence band. */
const BADGE_CLASS: Record<ConfidenceBand, string> = {
  strong: 'bg-emerald-100 text-emerald-800',
  likely: 'bg-amber-100 text-amber-800',
  uncertain: 'bg-gray-200 text-gray-700'
}

interface PredictionReviewModalProps {
  review: PredictionReview
  /** Disables every action while a mutation is in flight. */
  isPending: boolean
  onClose: () => void
  onSeek: (time: number) => void
  onConfirmAndPromote: (review: PredictionReview) => void
  onEditAndPromote: (review: PredictionReview) => void
  onMarkInvalid: (review: PredictionReview) => void
  /** Accept the prediction with one flagged stretch cut out. */
  onConfirmWithout: (review: PredictionReview, stretch: TimeRange) => void
  isPlaying: boolean
  /** Play `range` and stop, without closing the modal. */
  onListen: (range: TimeRange) => void
  onPause: () => void
}

/**
 * Confidence for the bounds the *model* predicted, not any edited bounds --
 * those are the reviewer's answer, and the fit was trained on the prediction's
 * own duration.
 */
function ConfidenceBadge({ review }: { review: PredictionReview }) {
  const calibrated = calibratedConfidence(
    review.predicted_confidence,
    review.predicted_end_time - review.predicted_start_time
  )
  if (!calibrated) return null

  return (
    <span
      className={`text-xs px-2.5 py-0.5 rounded-full font-semibold ${BADGE_CLASS[calibrated.band]}`}
      title={`${calibrated.label} estimated chance you confirm this, from the segment's evidence margin and length`}
    >
      {BAND_DESCRIPTIONS[calibrated.band]} &middot; {calibrated.label}
    </span>
  )
}

const rangeLabel = (range: TimeRange) => `${formatTime(range.startTime)}–${formatTime(range.endTime)}`

/**
 * Where to listen before accepting: the stretches the model carried the song
 * through without hearing it clearly (`listenStretches`), each with a way to
 * hear it and a way to accept the rest without it. When the prediction has
 * evidence parts and none of them is flagged, a single line says so, which is
 * itself useful: that prediction can be confirmed as it stands.
 */
function ListenSection({ review, songName, startTime, endTime, isPending, isPlaying, onListen, onPause, onConfirmWithout }: {
  review: PredictionReview
  songName: string
  startTime: number
  endTime: number
  isPending: boolean
  isPlaying: boolean
  onListen: (range: TimeRange) => void
  onPause: () => void
  onConfirmWithout: (review: PredictionReview, stretch: TimeRange) => void
}) {
  const parts = partsForReview(review)
  if (parts.length === 0) return null
  const stretches = listenStretches(parts)

  if (stretches.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-emerald-700">
        <Check className="w-3.5 h-3.5" />
        The model heard {songName} clearly across this whole prediction.
      </p>
    )
  }

  return (
    <section aria-labelledby="listen-heading" className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 id="listen-heading" className="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
          <Headphones className="w-4 h-4" />
          Worth a listen before confirming
        </h3>
        {isPlaying && (
          <button
            type="button"
            onClick={onPause}
            className="flex items-center gap-1 rounded border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 cursor-pointer"
          >
            <Pause className="w-3.5 h-3.5" />
            Pause
          </button>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-amber-900/80">
        The model carried {songName} through {stretches.length === 1 ? 'this stretch' : 'these stretches'} without
        hearing it clearly. That is usually noodling between two sessions of the song, and sometimes a pause or a
        hard passage.
      </p>
      <ul className="mt-3 space-y-2">
        {stretches.map((stretch) => {
          const kept = cutPieces(startTime, endTime, stretch.startTime, stretch.endTime)
          // A stretch spanning the whole prediction leaves nothing to keep:
          // the question is then whether this is the song at all.
          const wholePrediction = kept.length === 0
          const keeps = `keeps ${kept.map(rangeLabel).join(' and ')}`
          return (
            <li
              key={stretch.startTime}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-white px-3 py-2"
            >
              <div className="text-xs text-gray-800">
                <span className="font-semibold tabular-nums">{rangeLabel(stretch)}</span>
                <span className="text-gray-500">
                  {' · '}{Math.round(stretch.endTime - stretch.startTime)}s
                  {' · '}ranked {formatOrdinal(Math.round(stretch.meanRank) + 1)} here
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onListen({
                    startTime: Math.max(0, stretch.startTime - LISTEN_LEAD_IN_SEC),
                    endTime: stretch.endTime + LISTEN_LEAD_OUT_SEC
                  })}
                  title={`Play this stretch, from ${LISTEN_LEAD_IN_SEC}s before it to ${LISTEN_LEAD_OUT_SEC}s after`}
                  className="flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200 cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5" />
                  Listen
                </button>
                {!wholePrediction && (
                  <button
                    type="button"
                    onClick={() => onConfirmWithout(review, stretch)}
                    disabled={isPending}
                    title={`Confirm ${songName} without ${rangeLabel(stretch)}: ${keeps}`}
                    className="flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:bg-emerald-300 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <Scissors className="w-3.5 h-3.5" />
                    Confirm without it
                  </button>
                )}
              </div>
              <p className="basis-full text-[11px] text-gray-500">
                {wholePrediction
                  ? `This is the whole prediction. If it is not ${songName}, mark it invalid.`
                  : `Confirming without it ${keeps}.`}
              </p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Confirm, correct or reject one predicted segment. */
export function PredictionReviewModal({
  review,
  isPending,
  onClose,
  onSeek,
  onConfirmAndPromote,
  onEditAndPromote,
  onMarkInvalid,
  onConfirmWithout,
  isPlaying,
  onListen,
  onPause
}: PredictionReviewModalProps) {
  const { songName, startTime, endTime } = resolveReviewFields(review)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg bg-white shadow-xl overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b px-6 py-4 bg-gray-50">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Review Prediction</h2>
            <ConfidenceBadge review={review} />
          </div>
          <p className="mt-1 text-base font-semibold text-gray-900">{songName}</p>
          <div className="mt-1 text-xs text-gray-600 flex items-center gap-2">
            <span>{formatTime(startTime)} - {formatTime(endTime)}</span>
            <span>•</span>
            <span>{(endTime - startTime).toFixed(1)}s duration</span>
          </div>
        </div>

        <div className="p-6 space-y-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-gray-500 font-medium">Jump on roll:</span>
            <button
              type="button"
              onClick={() => onSeek(startTime)}
              className="px-2.5 py-1 bg-gray-100 hover:bg-gray-200 rounded text-gray-700 font-medium transition-colors cursor-pointer"
            >
              Start ({formatTime(startTime)})
            </button>
            <button
              type="button"
              onClick={() => onSeek(endTime)}
              className="px-2.5 py-1 bg-gray-100 hover:bg-gray-200 rounded text-gray-700 font-medium transition-colors cursor-pointer"
            >
              End ({formatTime(endTime)})
            </button>
          </div>
          <ListenSection
            review={review}
            songName={songName}
            startTime={startTime}
            endTime={endTime}
            isPending={isPending}
            isPlaying={isPlaying}
            onListen={onListen}
            onPause={onPause}
            onConfirmWithout={onConfirmWithout}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-t bg-gray-50">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors cursor-pointer"
              disabled={isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onMarkInvalid(review)}
              className="rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 text-red-700 px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              disabled={isPending}
            >
              {isPending ? 'Working...' : 'Mark Invalid'}
            </button>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => onEditAndPromote(review)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm"
              disabled={isPending}
            >
              <Edit3 className="w-4 h-4" />
              Edit &amp; Promote
            </button>
            <button
              type="button"
              onClick={() => onConfirmAndPromote(review)}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:bg-emerald-300 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm"
              disabled={isPending}
            >
              <Check className="w-4 h-4" />
              {isPending ? 'Working...' : 'Confirm & Promote'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
