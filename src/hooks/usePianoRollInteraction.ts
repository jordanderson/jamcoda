import { useRef, useState, useCallback } from 'react'

interface DragState {
  isDragging: boolean
  startX: number
  currentX: number
  startTime: number
  endTime: number
}

interface UsePianoRollInteractionProps {
  pixelsPerTimeStep: number
  onRegionSelect?: (startTime: number, endTime: number) => void
  onTimeClick?: (time: number) => void
  isEnabled: boolean
}

export function usePianoRollInteraction({
  pixelsPerTimeStep,
  onRegionSelect,
  onTimeClick,
  isEnabled
}: UsePianoRollInteractionProps) {
  const [dragState, setDragState] = useState<DragState>({
    isDragging: false,
    startX: 0,
    currentX: 0,
    startTime: 0,
    endTime: 0
  })

  const containerRef = useRef<SVGSVGElement>(null)

  const pixelToTime = useCallback((x: number) => {
    return x / pixelsPerTimeStep
  }, [pixelsPerTimeStep])

  const handleMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!isEnabled || !containerRef.current) return

    const rect = containerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const time = pixelToTime(x)

    setDragState({
      isDragging: true,
      startX: x,
      currentX: x,
      startTime: time,
      endTime: time
    })
  }, [isEnabled, pixelToTime])

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragState.isDragging || !containerRef.current) return

    const rect = containerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const time = pixelToTime(x)

    setDragState(prev => ({
      ...prev,
      currentX: x,
      endTime: time
    }))
  }, [dragState.isDragging, pixelToTime])

  const handleMouseUp = useCallback(() => {
    if (!dragState.isDragging) return

    const minTime = Math.min(dragState.startTime, dragState.endTime)
    const maxTime = Math.max(dragState.startTime, dragState.endTime)
    const duration = maxTime - minTime

    // Only create annotation if drag was significant (> 0.5 seconds)
    if (duration > 0.5) {
      onRegionSelect?.(minTime, maxTime)
    } else {
      // If it was just a click, trigger click handler
      onTimeClick?.(dragState.startTime)
    }

    setDragState({
      isDragging: false,
      startX: 0,
      currentX: 0,
      startTime: 0,
      endTime: 0
    })
  }, [dragState, onRegionSelect, onTimeClick])

  return {
    dragState,
    handlers: {
      onMouseDown: handleMouseDown,
      onMouseMove: handleMouseMove,
      onMouseUp: handleMouseUp
    },
    containerRef
  }
}
