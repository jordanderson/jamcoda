import { memo } from 'react'
import { Check, CircleSlash, Edit3, Sparkles } from 'lucide-react'
import { formatTime } from '@/utils/format'
import type { PredictionReview } from '@/api/localTypes'
import { resolveReviewFields } from '@core/predictionReview'
import type { CadenceFlourishInfo } from '@core/boundaries'

interface DetailPredictionListProps {
  predictions: PredictionReview[]
  flourishesById: Map<number, CadenceFlourishInfo>
  snappedBoundsById: Map<number, { startTime: number; endTime: number }>
  isPending: boolean
  onSeek: (time: number) => void
  onConfirmAndPromote: (review: PredictionReview) => void
  onTrimFlourishAndPromote: (review: PredictionReview, trimmedEnd: number) => void
  onSnapBoundsAndPromote: (review: PredictionReview, snappedStart: number, snappedEnd: number) => void
  onEditAndPromote: (review: PredictionReview) => void
  onMarkInvalid: (review: PredictionReview) => void
}

/**
 * List of unpromoted predictions shown on the detail page right below the piano roll.
 * Enables 1-click trimming, snapping, and promotion while using the visual roll as a guide.
 */
export const DetailPredictionList = memo(function DetailPredictionList({
  predictions,
  flourishesById,
  snappedBoundsById,
  isPending,
  onSeek,
  onConfirmAndPromote,
  onTrimFlourishAndPromote,
  onSnapBoundsAndPromote,
  onEditAndPromote,
  onMarkInvalid
}: DetailPredictionListProps) {
  if (predictions.length === 0) return null

  return (
    <div className="space-y-3">
      {predictions.map((review) => {
        const { songName, startTime, endTime } = resolveReviewFields(review)
        const flourish = flourishesById.get(review.id)
        const snapped = snappedBoundsById.get(review.id)
        const confidencePct = review.predicted_confidence !== null
          ? `${Math.round(review.predicted_confidence * 100)}%`
          : null

        return (
          <div
            key={review.id}
            className="border border-indigo-100 rounded-lg p-4 bg-indigo-50/20 hover:bg-indigo-50/40 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-gray-900">{songName}</span>
                {confidencePct && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-medium">
                    {confidencePct} conf
                  </span>
                )}
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">
                  {review.status}
                </span>
              </div>

              <div className="text-sm text-gray-600 mt-1 flex items-center gap-3 flex-wrap">
                <span className="flex items-center gap-1">
                  <button
                    onClick={() => onSeek(startTime)}
                    className="text-gray-700 hover:text-gray-900 font-medium transition-colors cursor-pointer underline"
                    title="Jump to start on piano roll"
                  >
                    {formatTime(startTime)}
                  </button>
                  <span className="text-gray-400">→</span>
                  <button
                    onClick={() => onSeek(endTime)}
                    className="text-gray-700 hover:text-gray-900 font-medium transition-colors cursor-pointer underline"
                    title="Jump to end on piano roll"
                  >
                    {formatTime(endTime)}
                  </button>
                </span>
                <span className="text-gray-400">•</span>
                <span>{formatTime(endTime - startTime)}</span>
              </div>

              {/* Actionable insight pills */}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {flourish && (
                  <div className="inline-flex items-center gap-1.5 rounded-full border border-purple-200 bg-purple-50 px-2.5 py-1">
                    <button
                      onClick={() => onSeek(flourish.trimmedEndTime)}
                      className="text-xs font-semibold text-purple-900 hover:text-purple-950 underline-offset-2 hover:underline cursor-pointer"
                      title={`Cadence ends at ${formatTime(flourish.trimmedEndTime)}. Followed by ${flourish.flourishNoteCount} flourish notes.`}
                    >
                      Trailing Flourish: +{(endTime - flourish.trimmedEndTime).toFixed(1)}s ({flourish.flourishNoteCount} notes)
                    </button>
                    <button
                      onClick={() => onTrimFlourishAndPromote(review, flourish.trimmedEndTime)}
                      disabled={isPending}
                      className="rounded bg-purple-600 hover:bg-purple-700 text-white px-2 py-0.5 text-[11px] font-semibold flex items-center gap-1 transition-colors cursor-pointer shadow-sm disabled:bg-purple-300"
                      title="Trim extraneous ending flourish and promote directly to annotations"
                    >
                      <Sparkles className="w-3 h-3" />
                      Trim & Promote
                    </button>
                  </div>
                )}

                {!flourish && snapped && (
                  <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1">
                    <span className="text-xs font-semibold text-amber-900">
                      Loose bounds ({formatTime(snapped.startTime)} - {formatTime(snapped.endTime)})
                    </span>
                    <button
                      onClick={() => onSnapBoundsAndPromote(review, snapped.startTime, snapped.endTime)}
                      disabled={isPending}
                      className="rounded bg-amber-600 hover:bg-amber-700 text-white px-2 py-0.5 text-[11px] font-semibold flex items-center gap-1 transition-colors cursor-pointer shadow-sm disabled:bg-amber-300"
                      title="Snap to first note onset and last acoustic release, then promote"
                    >
                      <Sparkles className="w-3 h-3" />
                      Snap & Promote
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap shrink-0">
              <button
                onClick={() => onConfirmAndPromote(review)}
                disabled={isPending}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-300 text-white rounded-lg text-xs font-semibold flex items-center gap-1 transition-colors shadow-sm cursor-pointer"
                title="Confirm and promote this prediction into annotations"
              >
                <Check className="w-3.5 h-3.5" />
                Confirm & Promote
              </button>

              <button
                onClick={() => onEditAndPromote(review)}
                disabled={isPending}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white rounded-lg text-xs font-semibold flex items-center gap-1 transition-colors shadow-sm cursor-pointer"
                title="Edit song name or boundary times before promoting"
              >
                <Edit3 className="w-3.5 h-3.5" />
                Edit & Promote
              </button>

              <button
                onClick={() => onMarkInvalid(review)}
                disabled={isPending}
                className="px-2.5 py-1.5 bg-gray-100 hover:bg-red-50 text-gray-700 hover:text-red-700 rounded-lg text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer"
                title="Mark this prediction as invalid"
              >
                <CircleSlash className="w-3.5 h-3.5" />
                Reject
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
})
