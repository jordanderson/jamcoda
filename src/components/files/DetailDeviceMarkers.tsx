import { memo } from 'react'

export interface DeviceMarker {
  key: string
  timeSec: number
  kind: 'bookmark' | 'skip'
  label: string
  /** Length of the silence, for skips only. */
  gapSec?: number
}

interface DetailDeviceMarkersProps {
  markers: DeviceMarker[]
  onSeek: (time: number) => void
}

/** Clickable chips for the device's own bookmarks and silence gaps. */
export const DetailDeviceMarkers = memo(function DetailDeviceMarkers({
  markers,
  onSeek
}: DetailDeviceMarkersProps) {
  if (markers.length === 0) return null

  return (
    <div className="mt-3">
      <div className="flex items-center gap-1.5 mb-1.5 text-xs text-gray-500">
        <span>Device markers</span>
        <span className="text-gray-400">— click to jump</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {markers.map((marker) => {
          const isBookmark = marker.kind === 'bookmark'

          return (
            <button
              key={marker.key}
              type="button"
              onClick={() => onSeek(marker.timeSec)}
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-300"
              title={
                isBookmark
                  ? `Device bookmark at ${marker.label} (${marker.timeSec.toFixed(1)}s)`
                  : `Silence gap ${marker.gapSec}s at ${marker.label} (${marker.timeSec.toFixed(1)}s)`
              }
              style={{
                borderColor: isBookmark ? 'rgba(22, 163, 74, 0.4)' : 'rgba(34, 197, 94, 0.35)',
                backgroundColor: isBookmark ? 'rgba(22, 163, 74, 0.08)' : 'rgba(34, 197, 94, 0.05)',
                color: isBookmark ? '#166534' : '#15803d'
              }}
            >
              <span
                className={isBookmark ? 'bg-green-600 rounded-full' : 'rounded-full'}
                style={
                  isBookmark
                    ? { width: 8, height: 8 }
                    : { width: 8, height: 8, border: '2px solid rgba(34, 197, 94, 0.75)' }
                }
              />
              {marker.label}
            </button>
          )
        })}
      </div>
    </div>
  )
})
