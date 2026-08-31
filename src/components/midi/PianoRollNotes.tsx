import { memo } from 'react'
import type { NoteRect } from './pianoRollGeometry'

interface PianoRollNotesProps {
  rects: NoteRect[]
}

/**
 * The note rectangles, isolated behind `memo`.
 *
 * A long recording renders tens of thousands of rects (a 39-minute file is
 * ~18,000, which is 99% of the page's DOM nodes). The playhead updates
 * `currentTime` on every animation frame, so without this boundary React would
 * reconcile every rect ~60 times a second and playback would visibly stutter.
 *
 * `rects` only changes when the loaded sequence does, so this subtree is
 * skipped entirely during playback. Magenta's visualizer avoided the problem by
 * drawing into the SVG imperatively, outside React's tree; this keeps the
 * declarative rendering and gets the same result.
 */
export const PianoRollNotes = memo(function PianoRollNotes({ rects }: PianoRollNotesProps) {
  return (
    <>
      {rects.map((rect, index) => (
        <rect
          key={index}
          className="note"
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          fill={rect.fill}
        />
      ))}
    </>
  )
})
