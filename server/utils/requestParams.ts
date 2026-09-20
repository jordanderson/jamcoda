/**
 * Parsers for untrusted request values.
 *
 * Query strings and JSON bodies both arrive as `unknown`. Each parser returns
 * `undefined` for anything it cannot read, so a route can tell "absent or
 * unusable" from a real value without repeating the checks.
 */

/** A non-empty trimmed string, or `undefined`. */
export function parseSongName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A finite number, or `undefined`. */
export function parseOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/** A whole number, or `undefined`. */
export function parseOptionalInt(value: unknown): number | undefined {
  const num = parseOptionalNumber(value);
  return num !== undefined && Number.isInteger(num) ? num : undefined;
}

/** A boolean, accepting the `'true'` / `'false'` a query string carries. */
export function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return undefined;
}
