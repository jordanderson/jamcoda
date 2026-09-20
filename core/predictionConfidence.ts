/**
 * Display-only calibration for prediction confidence.
 *
 * `prediction_reviews.predicted_confidence` stores the decoder's evidence
 * margin, `(top1 - top2) / (|top1| + |top2|)`, averaged over a segment's
 * windows. It is a separation ratio, not a probability, and a correct match
 * cannot approach 1: the nearest-prototype distance is bounded below by the
 * spacing of the prototypes themselves. Rendered raw it also reads backwards
 * against the review verdicts -- segments shown at 30-39% were confirmed far
 * more often than those shown at 70-79%, because a long take averages toward
 * the typical margin while a short spurious burst does not.
 *
 * `calibratedConfidence` maps (margin, duration) to "would a reviewer confirm
 * this?", so the displayed number moves with reliability. **Nothing here feeds
 * the model.** `anchorMargin`, `linkConfidence` and `minSegmentConfidence` are
 * tuned against the raw margin scale, so changing what that scale means would
 * silently move the decoder.
 */

/**
 * Logistic weights over `confidenceFeatures`, fit on the reviewed predictions
 * in `prediction_reviews`.
 *
 * The margin weight is negative -- that is the inversion described above, read
 * off the data. Regenerate with `npm run ml:fit-confidence`, which prints this
 * block and the fit quality behind it.
 */
export const CONFIDENCE_WEIGHTS = {
  bias: -0.7402,
  margin: -0.9603,
  logDuration: 1.2895
} as const;

export type ConfidenceBand = 'strong' | 'likely' | 'uncertain';

export interface CalibratedConfidence {
  /** Estimated probability a reviewer confirms this prediction, in [0, 1]. */
  probability: number;
  band: ConfidenceBand;
  /** `probability` as a rounded percentage string, e.g. `86%`. */
  label: string;
}

/** Set where the in-sample calibration bends, rather than at round numbers. */
const STRONG_THRESHOLD = 0.75;
const LIKELY_THRESHOLD = 0.55;

/**
 * The model's input vector, `[1, margin, log10(seconds)]`.
 *
 * The scorer below and `ml:fit-confidence` both call this, so the fit and the
 * prediction cannot disagree about what the weights multiply.
 */
export function confidenceFeatures(rawMargin: number, durationSec: number): number[] {
  // The decoder's window step is one second, so nothing shorter carries
  // independent evidence; this is also what keeps log10 from running away.
  return [1, rawMargin, Math.log10(Math.max(1, durationSec))];
}

/** Clamped so an extreme input cannot produce a NaN through `Math.exp`. */
export function logistic(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

export function confidenceBand(probability: number): ConfidenceBand {
  if (probability >= STRONG_THRESHOLD) return 'strong';
  if (probability >= LIKELY_THRESHOLD) return 'likely';
  return 'uncertain';
}

/**
 * Calibrate one segment's raw margin against its own length.
 *
 * A null margin (older rows predate the field) returns null, so a caller
 * renders nothing rather than a fabricated number.
 */
export function calibratedConfidence(
  rawMargin: number | null,
  durationSec: number
): CalibratedConfidence | null {
  if (rawMargin === null || !Number.isFinite(rawMargin)) return null;
  if (!Number.isFinite(durationSec)) return null;

  const [bias, margin, logDuration] = confidenceFeatures(rawMargin, durationSec);
  const probability = logistic(
    (CONFIDENCE_WEIGHTS.bias * bias)
    + (CONFIDENCE_WEIGHTS.margin * margin)
    + (CONFIDENCE_WEIGHTS.logDuration * logDuration)
  );

  return {
    probability,
    band: confidenceBand(probability),
    label: `${Math.round(probability * 100)}%`
  };
}

/** Human-readable band, for tooltips and screen readers. */
export const BAND_DESCRIPTIONS: Record<ConfidenceBand, string> = {
  strong: 'strong match',
  likely: 'likely match',
  uncertain: 'uncertain match'
};
