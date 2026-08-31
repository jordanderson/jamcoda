import { useCallback, useRef, useState, type RefObject } from 'react'

interface DragState {
  isDragging: boolean
  startX: number
  currentX: number
}

interface UsePianoRollInteractionProps {
  /**
   * The `<svg>` the drag is measured against. Passed in rather than owned here
   * so there is a single ref to the element; a copy kept in sync by an effect
   * goes stale on remount and measures against a detached node.
   */
  svgRef: RefObject<SVGSVGElement | null>
  pixelsPerTimeStep: number
  onRegionSelect?: (startTime: number, endTime: number) => void
  onTimeClick?: (time: number) => void
  isEnabled: boolean
}

/** A drag shorter than this is treated as a click-to-seek instead. */
const MIN_REGION_DURATION_SECONDS = 0.5

export function usePianoRollInteraction({
  svgRef,
  pixelsPerTimeStep,
  onRegionSelect,
  onTimeClick,
  isEnabled
}: UsePianoRollInteractionProps) {
  const [dragState, setDragState] = useState<DragState>({
    isDragging: false,
    startX: 0,
    currentX: 0
  })
  /** Mirrors `dragState` so the handlers stay referentially stable. */
  const dragRef = useRef(dragState)

  const setDrag = useCallback((next: DragState) => {
    dragRef.current = next
    setDragState(next)
  }, [])

  const offsetX = useCallback((clientX: number): number | null => {
    const svg = svgRef.current
    if (!svg) return null
    return clientX - svg.getBoundingClientRect().left
  }, [svgRef])

  const handleMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!isEnabled) return
    const x = offsetX(e.clientX)
    if (x === null) return
    setDrag({ isDragging: true, startX: x, currentX: x })
  }, [isEnabled, offsetX, setDrag])

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragRef.current.isDragging) return
    const x = offsetX(e.clientX)
    if (x === null) return
    setDrag({ ...dragRef.current, currentX: x })
  }, [offsetX, setDrag])

  const handleMouseUp = useCallback(() => {
    const drag = dragRef.current
    if (!drag.isDragging) return

    const startTime = drag.startX / pixelsPerTimeStep
    const endTime = drag.currentX / pixelsPerTimeStep
    const minTime = Math.min(startTime, endTime)
    const maxTime = Math.max(startTime, endTime)

    if (maxTime - minTime > MIN_REGION_DURATION_SECONDS) {
      onRegionSelect?.(minTime, maxTime)
    } else {
      onTimeClick?.(startTime)
    }

    setDrag({ isDragging: false, startX: 0, currentX: 0 })
  }, [onRegionSelect, onTimeClick, pixelsPerTimeStep, setDrag])

  return {
    dragState,
    handlers: {
      onMouseDown: handleMouseDown,
      onMouseMove: handleMouseMove,
      onMouseUp: handleMouseUp
    }
  }
}
