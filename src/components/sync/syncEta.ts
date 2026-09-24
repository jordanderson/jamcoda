/** Files to process before the per-file rate is steady enough to project. */
const MIN_FILES_FOR_ETA = 3;
/** Elapsed time to wait for, for the same reason. */
const MIN_ELAPSED_MS_FOR_ETA = 5000;

/**
 * Seconds until the sync finishes at its average rate so far, or null while
 * too little has been processed to say. The rate includes the pause between
 * downloads, so it tracks wall time rather than transfer time.
 */
export function estimateSyncSecondsRemaining(
  filesProcessed: number,
  filesFound: number,
  elapsedMs: number | null
): number | null {
  if (elapsedMs === null || filesProcessed >= filesFound) return null;
  if (filesProcessed < MIN_FILES_FOR_ETA || elapsedMs < MIN_ELAPSED_MS_FOR_ETA) return null;
  const msPerFile = elapsedMs / filesProcessed;
  return ((filesFound - filesProcessed) * msPerFile) / 1000;
}
