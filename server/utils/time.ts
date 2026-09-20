/** Current time as whole seconds since the epoch, the unit every `*_at` column stores. */
export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}
