interface JamCodaLogoProps {
  className?: string
}

/**
 * The JamCoda mark: a coda sign whose vertical stroke is a serif J with a ball
 * terminal. Drawn in `currentColor`; the viewBox is cropped to the mark, so the
 * crossbar sits flush with whatever it is aligned against.
 */
export function JamCodaLogo({ className }: JamCodaLogoProps) {
  return (
    <svg viewBox="4 4 56 58" fill="currentColor" className={className} aria-hidden>
      <path
        fillRule="evenodd"
        d="M14.5 30a17.5 18 0 0 0 35 0a17.5 18 0 0 0-35 0zM20.25 30a11.75 15.4 0 0 0 23.5 0a11.75 15.4 0 0 0-23.5 0z"
      />
      <rect x="4" y="28.6" width="56" height="2.8" />
      <path d="M24.5 4h15v2.6h-1Q35 6.6 35 10v40c0 7.5-4.5 12-10.5 12-3 0-5.5-1.5-6.5-3.5l6.5.9c3 0 4.5-3.4 4.5-9.4V10q0-3.4-3.5-3.4h-1z" />
      <circle cx="21.5" cy="56.2" r="4.2" />
    </svg>
  )
}
