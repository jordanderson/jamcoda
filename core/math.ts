/**
 * Numeric helpers for both tiers.
 *
 * Separate from `core/cli/args`, which is Node-only and so not available to
 * the browser build.
 */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function roundTo(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
