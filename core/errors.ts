/** Error helpers shared by the client, the server and the CLI entry points. */

/**
 * The message from a thrown value.
 *
 * `catch` binds `unknown`, so every caller needs the same `instanceof` check
 * before reading `.message`. Without a `fallback` a non-`Error` is stringified,
 * which is what a CLI wants; UI callers pass the message to show instead.
 */
export function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  return fallback ?? String(error);
}
