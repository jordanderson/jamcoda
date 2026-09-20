import { useEffect, useRef } from 'react'

export interface DetailShortcuts {
  /** Playback keys are ignored until the file is loaded. */
  isLoaded: boolean
  hasCheckpoint: boolean
  /** While a modal owns the screen, keys must not reach the roll behind it. */
  isModalOpen: boolean
  onPlayPause: () => void
  onMarkStart: () => void
  onMarkEnd: () => void
  onClearCheckpoints: () => void
}

/**
 * Keyboard shortcuts for the detail page: P play/pause, S mark start, E mark
 * end, C clear.
 *
 * The listener subscribes once and reads the latest values through a ref.
 * Depending on them directly would tear it down and re-add it on every
 * animation frame during playback.
 */
export function useDetailShortcuts(shortcuts: DetailShortcuts): void {
  const latest = useRef(shortcuts)
  useEffect(() => {
    latest.current = shortcuts
  })

  useEffect(() => {
    const handleKeyPress = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return
      }

      const current = latest.current
      if (current.isModalOpen) return

      // Leave browser and OS chords (cmd+P print, ctrl+S save) alone.
      if (event.metaKey || event.ctrlKey || event.altKey) return

      switch (event.key.toLowerCase()) {
        case 'p':
          if (!current.isLoaded) return
          // Space already scrolls the page. P is the unambiguous binding.
          event.preventDefault()
          current.onPlayPause()
          return
        case 's':
          current.onMarkStart()
          return
        case 'e':
          current.onMarkEnd()
          return
        case 'c':
          if (current.hasCheckpoint) current.onClearCheckpoints()
          return
        default:
      }
    }

    window.addEventListener('keydown', handleKeyPress)
    return () => window.removeEventListener('keydown', handleKeyPress)
  }, [])
}
