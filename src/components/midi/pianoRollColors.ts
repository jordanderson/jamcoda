/**
 * Colour and label helpers for the piano roll's overlay layers.
 *
 * Song colours are derived from the name so the same song keeps its colour
 * across files and across the annotation, timeline and prediction rows.
 */

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = value.charCodeAt(i) + ((hash << 5) - hash)
  }
  return hash
}

/** Background band drawn behind the notes. */
export function stringToColor(str: string): string {
  return `hsl(${hashString(str) % 360}, 70%, 60%)`
}

/** Readable text on top of a song-coloured chip. */
export function stringToTextColor(str: string): string {
  return `hsl(${hashString(str) % 360}, 80%, 20%)`
}

/** Chip fill on the annotation timeline row. */
export function stringToTimelineColor(str: string): string {
  return `hsla(${hashString(str) % 360}, 70%, 62%, 0.7)`
}

/** Chip fill on the prediction row, with confidence carried in the alpha. */
export function stringToPredictionTimelineColor(
  str: string,
  confidence: number | null
): string {
  const safeConfidence = confidence === null
    ? 0.5
    : Math.min(1, Math.max(0, confidence))
  const alpha = 0.25 + (safeConfidence * 0.45)
  return `hsla(${hashString(str) % 360}, 75%, 65%, ${alpha.toFixed(2)})`
}

/**
 * Label positions inside a timeline chip.
 *
 * A chip can be thousands of pixels wide, so the label repeats along it and
 * stays readable wherever the roll happens to be scrolled.
 */
export function buildRepeatingLabelOffsets(widthPx: number): number[] {
  const offsets: number[] = []
  const startOffset = 8
  const repeatGap = 1000

  for (let offset = startOffset; offset < widthPx; offset += repeatGap) {
    offsets.push(offset)
  }

  if (offsets.length === 0) {
    offsets.push(startOffset)
  }

  return offsets
}

/** Keeps the delete button clear of the repeated label text. */
export function getDeleteButtonOffset(label: string): number {
  return Math.max(28, (label.length * 6.5) + 12)
}
