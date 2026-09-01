import { memo } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { formatTime } from '@/utils/format'
import { getGapAction, type AnnotationGap, type GapAction } from './annotationGaps'
import type { RollAnnotation } from '@/components/midi/pianoRollTypes'

interface DetailAnnotationListProps {
  annotations: RollAnnotation[]
  /** Precomputed silent stretches, keyed by annotation id. */
  gapsById: Map<number, AnnotationGap[]>
  /** `${annotationId}:${gapIndex}` of the edit currently in flight. */
  splittingGapKey: string | null
  onSeek: (time: number) => void
  onEdit: (annotation: RollAnnotation) => void
  onDelete: (annotationId: number) => void
  onSplitGap: (annotation: RollAnnotation, gap: AnnotationGap, gapIndex: number) => void
  onTrimGap: (annotation: RollAnnotation, gap: AnnotationGap, gapIndex: number) => void
}

const GAP_ACTION_LABEL: Record<GapAction, string> = {
  split: 'Split',
  'trim-start': 'Trim Start',
  'trim-end': 'Trim End',
  none: 'N/A'
}

const GAP_ACTION_TITLE: Record<GapAction, string> = {
  split: 'Split annotation around this gap',
  'trim-start': 'Trim annotation start to the end of this gap',
  'trim-end': 'Trim annotation end to the start of this gap',
  none: 'Cannot split or trim this gap'
}

/**
 * The annotation list below the roll. `memo`'d because `DetailPage` re-renders
 * every animation frame during playback. Its time readout depends on
 * `currentTime`, and this is the largest subtree that does not depend on the
 * playhead.
 */
export const DetailAnnotationList = memo(function DetailAnnotationList({
  annotations,
  gapsById,
  splittingGapKey,
  onSeek,
  onEdit,
  onDelete,
  onSplitGap,
  onTrimGap
}: DetailAnnotationListProps) {
  if (annotations.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <p>No annotations yet</p>
        <p className="text-sm mt-2">Click "Add Annotation" to mark song segments</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {annotations.map((annotation) => {
        const gaps = gapsById.get(annotation.id) ?? []

        return (
          <div
            key={annotation.id}
            className="border rounded-lg p-4 flex justify-between items-start hover:bg-gray-50 transition-colors"
          >
            <div className="flex-1">
              <div className="font-semibold text-gray-900">{annotation.song_name}</div>
              <div className="text-sm text-gray-600 mt-1 flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <button
                    onClick={() => onSeek(annotation.start_time)}
                    className="text-gray-700 hover:text-gray-900 font-medium transition-colors cursor-pointer underline"
                    title="Jump to start"
                  >
                    {formatTime(annotation.start_time)}
                  </button>
                  <span className="text-gray-400">→</span>
                  <button
                    onClick={() => onSeek(annotation.end_time)}
                    className="text-gray-700 hover:text-gray-900 font-medium transition-colors cursor-pointer underline"
                    title="Jump to end"
                  >
                    {formatTime(annotation.end_time)}
                  </button>
                </span>
                <span className="text-gray-400">•</span>
                <span>{formatTime(annotation.end_time - annotation.start_time)}</span>
              </div>

              {gaps.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {gaps.map((gap, index) => {
                    const action = getGapAction(gap, annotation)
                    const gapKey = `${annotation.id}:${index}`
                    const isWorking = splittingGapKey === gapKey

                    return (
                      <div
                        key={`${annotation.id}-gap-${index}`}
                        className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-1"
                      >
                        <button
                          onClick={() => onSeek((gap.startTime + gap.endTime) / 2)}
                          className="text-xs font-semibold text-amber-900 hover:text-amber-950 underline-offset-2 hover:underline"
                          title={`Jump to gap ${formatTime(gap.startTime)} - ${formatTime(gap.endTime)}`}
                        >
                          Gap {index + 1}: {formatTime(gap.startTime)} - {formatTime(gap.endTime)} ({gap.durationSec.toFixed(1)}s)
                        </button>
                        <button
                          onClick={() => {
                            if (action === 'split') {
                              onSplitGap(annotation, gap, index)
                              return
                            }
                            onTrimGap(annotation, gap, index)
                          }}
                          disabled={action === 'none' || isWorking}
                          className="rounded bg-amber-200 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
                          title={GAP_ACTION_TITLE[action]}
                        >
                          {isWorking ? 'Working...' : GAP_ACTION_LABEL[action]}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}

              {annotation.notes && (
                <div className="text-sm text-gray-700 mt-2 italic">{annotation.notes}</div>
              )}
            </div>

            <div className="flex gap-2 ml-4">
              <button
                onClick={() => onEdit(annotation)}
                className="text-gray-600 hover:text-gray-900 text-sm font-medium flex items-center gap-1"
                title="Edit annotation"
              >
                <Pencil className="w-4 h-4" />
              </button>
              <button
                onClick={() => onDelete(annotation.id)}
                className="text-red-600 hover:text-red-700 text-sm font-medium flex items-center gap-1"
                title="Delete annotation"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
})
