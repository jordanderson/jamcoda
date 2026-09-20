/**
 * Display-only calibration for prediction confidence.
 *
 * The number the model stores in `prediction_reviews.predicted_confidence` is
 * the decoder's evidence margin: `(top1 - top2) / (|top1| + |top2|)` per window
 * (`ml/songSegmentation.ts` `computeEvidence`), averaged over the segment's
 * windows. In the shipped `min` score mode every score is a negative distance,
 * so the margin reduces to `(d2 - d1) / (d2 + d1)` -- a normalized separation
 * between the best song's nearest prototype and the runner-up's. It is a
 * separation ratio, not a probability:
 *
 *   margin 0.15 (the anchor threshold) -> runner-up is 1.35x farther
 *   margin 0.40                        -> runner-up is 2.33x farther
 *
 * Rendering that raw as "40%" read as a weak guess when it was a decisive
 * match, and two properties made it actively misleading:
 *
 * 1. A correct match cannot approach 100%. `d1` is bounded below by the
 *    spacing of the prototypes themselves (~2.0-2.5 in z-scored feature
 *    space), so a confident window lands near 0.28-0.45 by construction.
 * 2. A segment's confidence is the *mean* over its windows, so a long take
 *    averages toward the typical margin while a short spurious burst of
 *    distinctive material does not get averaged down. Against the review
 *    verdicts the raw number is anti-correlated with correctness: segments
 *    displayed at 30-39% reviewed 92% good, those at 70-79% reviewed 48% good.
 *
 * `calibratedConfidence` maps (margin, duration) to an estimate of "would a
 * human confirm this?", so the displayed number moves the same direction as
 * reliability. **Nothing here feeds the model.** `anchorMargin`,
 * `linkConfidence` and `minSegmentConfidence` are all tuned against the raw
 * margin scale and re-swept in ml/CHANGELOG.md 2026-09-07; changing what that
 * scale means would silently move the decoder.
 */

/**
 * Logistic weights over `[1, margin, log10(durationSec)]`, fit on the 250
 * reviewed predictions in `prediction_reviews` (166 confirmed or edited, 84
 * invalid) as of 2026-09-09.
 *
 * The margin weight is *negative*. That is the inversion described above, read
 * straight off the data rather than assumed.
 *
 * Fit quality: 5-fold CV AUC 0.727 (folds 0.642 / 0.711 / 0.770 / 0.670 /
 * 0.842), in-sample 0.719, against 0.671 for the raw margin alone. In-sample
 * calibration: rows scored 40-60% confirmed 48.0%, 60-80% confirmed 71.4%,
 * 80-100% confirmed 86.3%.
 *
 * Two honest limits on these numbers, both worth re-checking before anyone
 * leans harder on them:
 * - The training rows are not a random sample. Review rows only exist on files
 *   that are not marked complete (marking a file complete clears them), and
 *   1,085 predictions are still `unsure` and contribute nothing.
 * - Margin and duration are entangled -- high-margin segments are short ones
 *   (mean 38s against 133s) -- so the two weights should be read as one joint
 *   fit, not as two independent effects.
 *
 * Regenerate with `npm run ml:fit-confidence`, which prints this block.
 */
export const CONFIDENCE_WEIGHTS = {
  bias: -0.7402,
  margin: -0.9603,
  logDuration: 1.2895
} as const

export type ConfidenceBand = 'strong' | 'likely' | 'uncertain'

export interface CalibratedConfidence {
  /** Estimated probability a reviewer confirms this prediction, in [0, 1]. */
  probability: number
  band: ConfidenceBand
  /** `probability` as a rounded percentage string, e.g. `86%`. */
  label: string
}

/**
 * Band thresholds, set where the in-sample calibration bends rather than at
 * round numbers: predictions scoring 40-60% confirmed 48.0%, 60-80% confirmed
 * 71.4%, and 80-100% confirmed 86.3%.
 */
const STRONG_THRESHOLD = 0.75
const LIKELY_THRESHOLD = 0.55

function logistic(z: number): number {
  // Clamped so an extreme duration cannot produce a NaN through Math.exp.
  const bounded = Math.max(-30, Math.min(30, z))
  return 1 / (1 + Math.exp(-bounded))
}

export function confidenceBand(probability: number): ConfidenceBand {
  if (probability >= STRONG_THRESHOLD) return 'strong'
  if (probability >= LIKELY_THRESHOLD) return 'likely'
  return 'uncertain'
}

/**
 * Calibrate one segment's raw margin against how long the segment is.
 *
 * `rawMargin` is the stored `predicted_confidence`; `durationSec` is the
 * segment's own length. A null margin (older rows predate the field) has no
 * calibration and returns null, so a caller renders nothing rather than a
 * fabricated number.
 */
export function calibratedConfidence(
  rawMargin: number | null,
  durationSec: number
): CalibratedConfidence | null {
  if (rawMargin === null || !Number.isFinite(rawMargin)) return null
  if (!Number.isFinite(durationSec)) return null

  // A sub-second segment would drive log10 negative without bound; one second
  // is the floor because the decoder's window step is one second, so nothing
  // shorter carries independent evidence.
  const seconds = Math.max(1, durationSec)
  const probability = logistic(
    CONFIDENCE_WEIGHTS.bias
    + (CONFIDENCE_WEIGHTS.margin * rawMargin)
    + (CONFIDENCE_WEIGHTS.logDuration * Math.log10(seconds))
  )

  return {
    probability,
    band: confidenceBand(probability),
    label: `${Math.round(probability * 100)}%`
  }
}

/** Human-readable band, for tooltips and screen readers. */
export const BAND_DESCRIPTIONS: Record<ConfidenceBand, string> = {
  strong: 'strong match',
  likely: 'likely match',
  uncertain: 'uncertain match'
}
