import type { Note } from '@core/midi/noteSequence'

/**
 * Note-rectangle geometry for the piano roll.
 *
 * This reproduces the layout `@magenta/music`'s `PianoRollSVGVisualizer`
 * produced, so the roll renders identically after that dependency was dropped:
 * two semitones of padding above and below the pitch range, rows growing
 * upward from the bottom edge, and per-note opacity derived from velocity.
 *
 * The horizontal mapping (`time * pixelsPerTimeStep`) is the same one the
 * annotation, prediction and playhead overlays already use, which is why they
 * line up with the notes.
 */

/** Semitones of headroom drawn above and below the sequence's pitch range. */
const PITCH_PADDING = 2

/** Magenta never drew a note narrower than this, so neither do we. */
const MIN_NOTE_WIDTH = 1

export interface PianoRollConfig {
  pixelsPerTimeStep: number
  noteHeight: number
  /** Horizontal gap trimmed from each note so adjacent notes stay distinct. */
  noteSpacing: number
  /** `r, g, b` triple, matching the theme's note color. */
  noteRGB: string
}

export interface NoteRect {
  x: number
  y: number
  width: number
  height: number
  fill: string
}

export interface PianoRollLayout {
  height: number
  rects: NoteRect[]
}

/**
 * Velocity-derived opacity. Magenta's formula, kept so shading is unchanged:
 * a floor of 0.2 plus velocity/100, and fully opaque when velocity is absent.
 */
function noteOpacity(velocity: number): number {
  return velocity ? velocity / 100 + 0.2 : 1
}

export function buildPianoRollLayout(
  notes: Note[],
  config: PianoRollConfig
): PianoRollLayout {
  if (notes.length === 0) {
    return { height: 0, rects: [] }
  }

  let minPitch = notes[0].pitch
  let maxPitch = notes[0].pitch
  for (const note of notes) {
    if (note.pitch < minPitch) minPitch = note.pitch
    if (note.pitch > maxPitch) maxPitch = note.pitch
  }
  minPitch -= PITCH_PADDING
  maxPitch += PITCH_PADDING

  const height = (maxPitch - minPitch) * config.noteHeight

  const rects = notes.map((note) => {
    const duration = note.endTime - note.startTime
    return {
      x: Math.round(note.startTime * config.pixelsPerTimeStep),
      y: Math.round(height - (note.pitch - minPitch) * config.noteHeight),
      width: Math.round(
        Math.max(config.pixelsPerTimeStep * duration - config.noteSpacing, MIN_NOTE_WIDTH)
      ),
      height: Math.round(config.noteHeight),
      fill: `rgba(${config.noteRGB}, ${noteOpacity(note.velocity)})`
    }
  })

  return { height, rects }
}
