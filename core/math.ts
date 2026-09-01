/**
 * Small numeric helpers used on both sides of the app.
 *
 * These live here rather than in `core/cli/args` because that module is
 * Node-only (it reads `process.argv` and touches the filesystem) and so is
 * excluded from the browser program. The piano roll previously kept its own
 * copy of `clamp` for that reason.
 */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function roundTo(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
