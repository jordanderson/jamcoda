/**
 * Display formatting shared across the UI.
 *
 * `formatTime` previously existed as five identical copies (DetailPage,
 * PredictionReviewPage, SongsPage, AnnotationModal, DateBrowser) and
 * `formatDate` as three. One of the `formatTime` copies was re-created on
 * every render rather than hoisted to module scope.
 */

/** Seconds as `m:ss`, for playback positions and segment bounds. */
export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

/** Seconds as `h:mm:ss` (hours always shown), for long-position markers. */
export function formatTimeHms(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

/** A `YYYY-MM-DD` recording date as `Mon D, YYYY` in the viewer's locale. */
export function formatDate(dateStr: string): string {
  // Parsed as local midnight, not UTC, so the displayed day matches the
  // recording date rather than shifting by timezone.
  const date = new Date(`${dateStr}T00:00:00`)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

/**
 * Seconds as `m:ss`.
 *
 * Durations and playback positions render identically. DateBrowser had a
 * separate `formatDuration` whose body was byte-identical to `formatTime`,
 * so this is an alias rather than a second implementation.
 */
export const formatDuration = formatTime
