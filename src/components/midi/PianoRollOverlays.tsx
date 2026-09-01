import { memo } from 'react'
import { stringToColor } from './pianoRollColors'
import type { RollAnnotation, RollBookmark, RollSkip } from './pianoRollTypes'

/**
 * Static layers drawn over the notes.
 *
 * `memo`'d for the same reason `PianoRollNotes` is. The roll re-renders every
 * animation frame while the playhead moves, and these layers hold hundreds
 * of absolutely positioned elements that only change with the annotations.
 */

interface AnnotationBandsProps {
  annotations: RollAnnotation[]
  pixelsPerTimeStep: number
  /** Bands are only meaningful once there are notes to sit behind. */
  hasNotes: boolean
}

/** Translucent song-coloured bands behind the note rectangles. */
export const AnnotationBands = memo(function AnnotationBands({
  annotations,
  pixelsPerTimeStep,
  hasNotes
}: AnnotationBandsProps) {
  if (annotations.length === 0 || !hasNotes) return null

  return (
    <div className="absolute top-0 left-0 pointer-events-none z-0">
      {annotations.map((annotation) => (
        <div
          key={annotation.id}
          className="absolute opacity-30"
          style={{
            left: `${annotation.start_time * pixelsPerTimeStep}px`,
            width: `${(annotation.end_time - annotation.start_time) * pixelsPerTimeStep}px`,
            backgroundColor: stringToColor(annotation.song_name),
            top: 0,
            height: '100%'
          }}
          title={`${annotation.song_name} (${annotation.start_time.toFixed(1)}s - ${annotation.end_time.toFixed(1)}s)`}
        />
      ))}
    </div>
  )
})

interface DeviceMarkerLayerProps {
  bookmarks: RollBookmark[]
  skips: RollSkip[]
  minSkipDisplaySec: number
  pixelsPerTimeStep: number
}

const MARKER_LINE_COLOR = 'rgba(22, 163, 74, 0.16)'

/** Jamcorder passage bookmarks and long silence gaps. */
export const DeviceMarkerLayer = memo(function DeviceMarkerLayer({
  bookmarks,
  skips,
  minSkipDisplaySec,
  pixelsPerTimeStep
}: DeviceMarkerLayerProps) {
  const visibleSkips = skips.filter((skip) => skip.millis >= minSkipDisplaySec * 1000)
  if (bookmarks.length === 0 && visibleSkips.length === 0) return null

  return (
    <div className="absolute top-0 left-0 pointer-events-none z-[7]">
      {bookmarks.map((bookmark) => (
        <div
          key={`bookmark-${bookmark.bookmarkIdx}`}
          className="absolute"
          style={{ left: bookmark.timeSec * pixelsPerTimeStep, top: 0, bottom: 0, width: 0 }}
        >
          <div
            className="absolute"
            style={{ left: 0, top: 0, bottom: 0, width: 2, transform: 'translateX(-50%)', backgroundColor: MARKER_LINE_COLOR }}
          />
          <div
            className="absolute rounded-full bg-green-600 border-2 border-white"
            style={{
              left: 0,
              top: 8,
              width: 18,
              height: 18,
              transform: 'translateX(-50%)',
              boxShadow: '0 1px 4px rgba(0, 0, 0, 0.35)'
            }}
            title={`Device bookmark ${bookmark.bookmarkIdx} (${bookmark.timeSec.toFixed(1)}s)`}
          />
        </div>
      ))}
      {visibleSkips.map((skip, index) => (
        <div
          key={`skip-${index}`}
          className="absolute"
          style={{ left: skip.timeSec * pixelsPerTimeStep, top: 0, bottom: 0, width: 0 }}
        >
          <div
            className="absolute"
            style={{ left: 0, top: 0, bottom: 0, width: 2, transform: 'translateX(-50%)', backgroundColor: MARKER_LINE_COLOR }}
          />
          <div
            className="absolute rounded-full"
            style={{
              left: 0,
              top: 10,
              width: 14,
              height: 14,
              transform: 'translateX(-50%)',
              border: '3px solid rgba(34, 197, 94, 0.75)',
              boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)'
            }}
            title={`Silence gap ${(skip.millis / 1000).toFixed(0)}s (${skip.timeSec.toFixed(1)}s)`}
          />
        </div>
      ))}
    </div>
  )
})

interface PlayheadProps {
  x: number
  /** Paused and stopped playheads stay visible, just quieter. */
  isPlaying: boolean
}

/**
 * The playback position line, rendered in every playback state. A hidden
 * playhead leaves no indication of where a paused or stopped file sits and
 * nothing visible for follow mode to be following.
 */
export const Playhead = memo(function Playhead({ x, isPlaying }: PlayheadProps) {
  const color = isPlaying ? 'rgba(230, 100, 101, 0.8)' : 'rgba(230, 100, 101, 0.45)'

  return (
    <div
      className="absolute pointer-events-none z-20"
      data-testid="piano-roll-playhead"
      style={{
        left: `${x}px`,
        top: 0,
        bottom: 0,
        width: '3px',
        backgroundColor: color,
        boxShadow: isPlaying ? '0 0 6px rgba(230, 100, 101, 0.5)' : 'none'
      }}
    >
      <div
        className="absolute"
        style={{
          top: '-8px',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 0,
          height: 0,
          borderLeft: '6px solid transparent',
          borderRight: '6px solid transparent',
          borderTop: `8px solid ${color}`
        }}
      />
    </div>
  )
})

interface CheckpointMarkerProps {
  x: number
  edge: 'start' | 'end'
}

/** Green start / red end checkpoint flags. */
export const CheckpointMarker = memo(function CheckpointMarker({ x, edge }: CheckpointMarkerProps) {
  const isStart = edge === 'start'

  return (
    <div
      className="absolute pointer-events-none z-20"
      style={{
        left: `${x}px`,
        top: 0,
        bottom: 0,
        width: '3px',
        backgroundColor: isStart ? 'rgba(34, 197, 94, 0.7)' : 'rgba(239, 68, 68, 0.7)',
        boxShadow: isStart ? '0 0 6px rgba(34, 197, 94, 0.5)' : '0 0 6px rgba(239, 68, 68, 0.5)'
      }}
    >
      <div
        className={`absolute text-white text-xs px-1 rounded ${isStart ? 'bg-green-500' : 'bg-red-500'}`}
        style={{ top: '-20px', left: '5px', fontSize: '10px', whiteSpace: 'nowrap' }}
      >
        {isStart ? 'Start' : 'End'}
      </div>
    </div>
  )
})
