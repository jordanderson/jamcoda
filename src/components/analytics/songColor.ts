/**
 * Stable per-song color for analytics charts.
 *
 * Same hashing idea as DateBrowser's `stringToColor` so a song keeps its
 * color everywhere, but tuned darker: these render as chart fills on white,
 * not pill backgrounds.
 */
export function songColor(song: string): string {
  let hash = 0;
  for (let i = 0; i < song.length; i += 1) {
    hash = song.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

/** Muted gray for the stacked "everything else" segment. */
export const OTHER_COLOR = '#9ca3af';
