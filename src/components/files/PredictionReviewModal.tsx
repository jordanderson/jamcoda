import { Check, Edit3 } from 'lucide-react'
import type { PredictionReview } from '@/api/localTypes'
import { resolveReviewFields } from '@core/predictionReview'
import {
  BAND_DESCRIPTIONS,
  calibratedConfidence,
  type ConfidenceBand
} from '@core/predictionConfidence'
import { formatTime } from '@/utils/format'

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

/** Confirm, correct or reject one predicted segment. */
export function PredictionReviewModal({
  review,
  isPending,
  onClose,
  onSeek,
  onConfirmAndPromote,
  onEditAndPromote,
  onMarkInvalid
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
