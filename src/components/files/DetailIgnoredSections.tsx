import { memo } from 'react'
import { formatTime } from '@/utils/format'

export interface IgnoredSectionRow {
  id: number
  start_time: number
  end_time: number
  reason?: string | null
}

interface DetailIgnoredSectionsProps {
  sections: IgnoredSectionRow[]
  isDeleting: boolean
  onSeek: (time: number) => void
  onDelete: (ignoredSectionId: number) => void
}

/** Ignored-section list below the roll. `memo`'d for the same reason the annotation list is. */
export const DetailIgnoredSections = memo(function DetailIgnoredSections({
  sections,
  isDeleting,
  onSeek,
  onDelete
}: DetailIgnoredSectionsProps) {
  if (sections.length === 0) {
    return (
      <div className="mt-4 rounded-lg border border-dashed border-gray-300 px-4 py-6 text-sm text-gray-500">
        No ignored sections for this file.
      </div>
    )
  }

  return (
    <div className="mt-4 space-y-2">
      {sections.map((section) => (
        <div
          key={section.id}
          className="flex items-start justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2"
        >
          <div className="flex-1">
            <div className="text-sm font-medium text-gray-900">
              {formatTime(section.start_time)} - {formatTime(section.end_time)} ({formatTime(section.end_time - section.start_time)})
            </div>
            {section.reason && (
              <div className="text-sm text-gray-600 mt-0.5">{section.reason}</div>
            )}
          </div>
          <div className="ml-3 flex gap-2">
            <button
              onClick={() => onSeek((section.start_time + section.end_time) / 2)}
              className="rounded bg-white px-2 py-1 text-xs font-medium text-gray-700 border border-gray-300 hover:bg-gray-100"
            >
              Jump
            </button>
            <button
              onClick={() => onDelete(section.id)}
              className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-300"
              disabled={isDeleting}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  )
})
