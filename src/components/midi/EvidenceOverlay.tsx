import { memo } from 'react'
import {
  evidenceStrength,
  listenStretches,
  type EvidencePart
} from '@core/predictionEvidence'
import { formatTime } from '@/utils/format'

/**
 * How firmly the model heard a predicted song, drawn inside the chip or span
 * that shows the prediction.
 *
 * Hatching with an amber underline marks a stretch worth a listen before the
 * prediction is accepted (`listenStretches`): the model carried the song
 * through it without hearing it clearly, which is most often noodling between
 * two sessions of the song and sometimes a pause or a hard passage. It means
 * the same thing everywhere it appears. With `fade`, stretches the model filled
 * in are also faded, more the weaker their evidence, so the whole-recording
 * view shows at a glance where a prediction is solid; the
 * piano-roll chip leaves that out, since its color already carries the
 * prediction's overall confidence.
 *
 * Purely visual and never a click target: the element it sits in handles the
 * click.
 */
export const EvidenceOverlay = memo(function EvidenceOverlay({ start, end, parts, fade = false }: {
  start: number
  end: number
  parts?: EvidencePart[]
  fade?: boolean
}) {
  const duration = end - start
  if (!parts || parts.length === 0 || duration <= 0) return null
  const place = (from: number, to: number) => ({
    left: `${((from - start) / duration) * 100}%`,
    width: `${((to - from) / duration) * 100}%`
  })

  return (
    <span aria-hidden className="pointer-events-none absolute inset-0">
      {fade && parts.map((part, index) => {
        const strength = evidenceStrength(part)
        if (strength >= 1) return null
        return (
          <span
            key={`fade-${index}`}
            className="absolute inset-y-0 bg-white"
            style={{ ...place(part.startTime, part.endTime), opacity: (1 - strength) * 0.6 }}
          />
        )
      })}
      {listenStretches(parts).map((stretch) => (
        <span
          key={`listen-${stretch.startTime}`}
          data-testid="listen-stretch"
          className="absolute inset-y-0 border-b-[3px] border-amber-600"
          style={{
            ...place(stretch.startTime, stretch.endTime),
            backgroundImage: 'repeating-linear-gradient(135deg, rgba(0,0,0,0.28) 0 2px, transparent 2px 6px)'
          }}
        />
      ))}
    </span>
  )
})

/** A sentence for a tooltip or label naming the stretches worth a listen, or null when there are none. */
export function listenSummary(parts: EvidencePart[] | undefined): string | null {
  const stretches = listenStretches(parts ?? [])
  if (stretches.length === 0) return null
  const where = stretches.map((s) => `${formatTime(s.startTime)}–${formatTime(s.endTime)}`).join(', ')
  return `${stretches.length === 1 ? '1 stretch' : `${stretches.length} stretches`} worth a listen: ${where}`
}
