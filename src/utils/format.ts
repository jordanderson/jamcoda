/** Display formatting shared across the UI. */

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

/** Durations render the same as playback positions. */
export const formatDuration = formatTime

/**
 * Seconds as `Nh Nm`, for totals across many files, where `m:ss` stops being
 * readable -- a whole library renders there as `11640:00`.
 */
export function formatHoursMinutes(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  return hours === 0 ? `${mins}m` : `${hours}h ${mins}m`
}

/**
 * A remaining-time estimate as `about 5s`, `about 3m`, or `about 1h 20m`,
 * rounded up so it never reads as zero while work remains.
 */
export function formatEta(seconds: number): string {
  const total = Math.max(1, Math.ceil(seconds))
  if (total < 60) return `about ${total}s`
  const mins = Math.ceil(total / 60)
  if (mins < 60) return `about ${mins}m`
  return `about ${formatHoursMinutes(mins * 60)}`
}
