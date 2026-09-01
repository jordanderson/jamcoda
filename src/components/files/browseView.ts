/**
 * Filter and sort for the browse table.
 *
 * `/api/files/by-date` returns every file in one payload, so the view is
 * applied client-side: changing sort or filter re-orders what is already
 * loaded rather than refetching.
 */

import type { FileByDateRow } from '@/api/localTypes'

export type BrowseSort = 'date-desc' | 'unreviewed-desc'

export interface BrowseView {
  sort: BrowseSort
  /** Hide files already marked complete -- the ones with no work left. */
  incompleteOnly: boolean
}

export const DEFAULT_BROWSE_VIEW: BrowseView = {
  sort: 'date-desc',
  incompleteOnly: false
}

export const BROWSE_SORT_LABELS: Record<BrowseSort, string> = {
  'date-desc': 'Newest first',
  'unreviewed-desc': 'Most unreviewed'
}

/** A browse row flattened out of its date group. */
export type BrowseFile = FileByDateRow & { date: string }

/**
 * Apply `view` to `files`, newest first within any tie.
 *
 * The server hands rows over ordered by `date_recorded DESC, filename ASC`.
 * Sort is stable, and every comparator here falls back to date, so files that
 * tie on the sort key keep that filename order instead of shuffling between
 * renders.
 */
export function applyBrowseView<T extends BrowseFile>(files: T[], view: BrowseView): T[] {
  const visible = view.incompleteOnly
    ? files.filter((file) => !file.isComplete)
    : [...files]

  if (view.sort === 'unreviewed-desc') {
    return visible.sort((a, b) => (
      b.unreviewedPredictionCount - a.unreviewedPredictionCount
      || b.date.localeCompare(a.date)
    ))
  }

  return visible.sort((a, b) => b.date.localeCompare(a.date))
}

/** Library-wide annotation progress, as shown above the browse table. */
export interface BrowseProgress {
  fileCount: number
  completeFileCount: number
  totalSeconds: number
  annotatedSeconds: number
  /** `annotatedSeconds` as a whole percent of `totalSeconds`. */
  percentage: number
}

/**
 * Roll every file's progress into one figure.
 *
 * A file marked complete counts as fully annotated whatever its annotations
 * add up to: completion is authoritative, and it is how a recording with
 * deliberately unannotated stretches -- warm-ups, ignored sections -- is
 * called done. Every other file contributes the span its annotations cover.
 *
 * Deliberately computed over the whole library rather than the current
 * filter: "60% annotated" answers how far the collection has come, and would
 * mean nothing if it moved every time the table was narrowed.
 */
export function getBrowseProgress(files: FileByDateRow[]): BrowseProgress {
  let totalSeconds = 0
  let annotatedSeconds = 0
  let completeFileCount = 0

  for (const file of files) {
    const duration = Math.max(0, file.totalDuration)
    totalSeconds += duration

    if (file.isComplete) {
      completeFileCount += 1
      annotatedSeconds += duration
      continue
    }

    // `annotatedDuration` sums annotations without merging them, so a file
    // with overlapping annotations reports more than it holds. Clamp per
    // file, or one such file pushes the whole library past 100%.
    annotatedSeconds += Math.min(duration, Math.max(0, file.annotatedDuration))
  }

  return {
    fileCount: files.length,
    completeFileCount,
    totalSeconds,
    annotatedSeconds,
    percentage: totalSeconds > 0 ? Math.round((annotatedSeconds / totalSeconds) * 100) : 0
  }
}
