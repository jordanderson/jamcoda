import { useMemo } from 'react';
import { formatHoursMinutes } from '@/utils/format';
import { bucketLabel, type Periodicity } from '@core/analytics';
import { OTHER_COLOR, songColor } from './songColor';

/**
 * Practice-over-time as stacked SVG bars: one group per bucket, segments for
 * the top 5 songs plus gray `Other`. Native `<title>` tooltips, no chart lib.
 */

const WIDTH = 800;
const HEIGHT = 250;
const PAD_LEFT = 46;
const PAD_RIGHT = 8;
const PAD_TOP = 10;
const PAD_BOTTOM = 28;
const STACK_TOP_N = 10;

interface TrendChartProps {
  buckets: string[];
  periodicity: Periodicity;
  series: Record<string, number[]>;
  topSongs: string[];
  selectedSong: string | null;
}

export function TrendChart({ buckets, periodicity, series, topSongs, selectedSong }: TrendChartProps) {
  const { bucketTotals, maxTotal, otherSeries } = useMemo(() => {
    const stacked = topSongs.slice(0, STACK_TOP_N);
    const stackedSet = new Set(stacked);
    const totals = buckets.map((_, i) => {
      let sum = 0;
      for (const song of Object.keys(series)) sum += series[song][i] ?? 0;
      return sum;
    });
    const other = buckets.map((_, i) => {
      let sum = 0;
      for (const song of Object.keys(series)) {
        if (!stackedSet.has(song)) sum += series[song][i] ?? 0;
      }
      return sum;
    });
    return {
      bucketTotals: totals,
      maxTotal: Math.max(1, ...totals),
      otherSeries: other
    };
  }, [buckets, series, topSongs]);

  const innerWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const slot = buckets.length > 0 ? innerWidth / buckets.length : innerWidth;
  const barWidth = Math.max(1.5, Math.min(48, slot * 0.62));
  const stackedSongs = topSongs.slice(0, STACK_TOP_N);
  const tickStep = Math.max(1, Math.ceil(buckets.length / 8));

  const yFor = (value: number) => PAD_TOP + innerHeight - (value / maxTotal) * innerHeight;

  return (
    <div className="bg-white border rounded-lg p-5">
      <h2 className="text-lg font-bold text-gray-900 mb-1">Practice over time</h2>
      <p className="text-xs text-gray-500 mb-3">
        Stacked annotated time per {periodicity === 'day' ? 'day' : periodicity}. Top {STACK_TOP_N} songs in color, the rest in gray.
      </p>

      {buckets.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing to chart in this range.</p>
      ) : (
        <>
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label="Stacked practice time per period">
            {[0, 0.5, 1].map((fraction) => {
              const y = yFor(maxTotal * fraction);
              return (
                <g key={fraction}>
                  <line x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={y} y2={y} stroke="#e5e7eb" strokeWidth={1} />
                  <text x={PAD_LEFT - 6} y={y + 4} textAnchor="end" fontSize={11} fill="#6b7280">
                    {formatHoursMinutes(maxTotal * fraction)}
                  </text>
                </g>
              );
            })}

            {buckets.map((bucket, i) => {
              const x = PAD_LEFT + slot * i + (slot - barWidth) / 2;
              const total = bucketTotals[i];
              if (total <= 0) {
                return (
                  <rect
                    key={bucket}
                    x={x}
                    y={PAD_TOP + innerHeight - 2}
                    width={barWidth}
                    height={2}
                    rx={1}
                    fill="#e5e7eb"
                  >
                    <title>{bucketLabel(bucket, periodicity)} — no practice</title>
                  </rect>
                );
              }
              let offset = 0;
              const segments: { song: string; value: number; color: string }[] = [
                ...stackedSongs.map((song) => ({
                  song,
                  value: series[song]?.[i] ?? 0,
                  color: songColor(song)
                })),
                { song: `Other (${topSongs.length > STACK_TOP_N ? topSongs.length - STACK_TOP_N : 0} more)`, value: otherSeries[i], color: OTHER_COLOR }
              ].filter((segment) => segment.value > 0);

              return (
                <g key={bucket} opacity={selectedSong && !stackedSongs.includes(selectedSong) ? 0.35 : 1}>
                  {segments.map((segment) => {
                    const height = (segment.value / maxTotal) * innerHeight;
                    const y = yFor(offset + segment.value);
                    offset += segment.value;
                    const dimmed = selectedSong !== null && segment.song !== selectedSong && !segment.song.startsWith('Other');
                    return (
                      <rect
                        key={segment.song}
                        x={x}
                        y={y}
                        width={barWidth}
                        height={Math.max(0.5, height)}
                        fill={segment.color}
                        opacity={dimmed ? 0.2 : 1}
                      >
                        <title>
                          {bucketLabel(bucket, periodicity)} — {segment.song}: {formatHoursMinutes(segment.value)}
                        </title>
                      </rect>
                    );
                  })}
                </g>
              );
            })}

            {buckets.map((bucket, i) => (
              i % tickStep === 0 ? (
                <text
                  key={bucket}
                  x={PAD_LEFT + slot * i + slot / 2}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                  fontSize={11}
                  fill="#6b7280"
                >
                  {bucketLabel(bucket, periodicity)}
                </text>
              ) : null
            ))}
          </svg>

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {stackedSongs.map((song) => (
              <span key={song} className="inline-flex items-center gap-1.5 text-xs text-gray-600">
                <span
                  className="inline-block w-2.5 h-2.5 rounded-sm"
                  style={{ backgroundColor: songColor(song) }}
                />
                {song}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: OTHER_COLOR }} />
              Other
            </span>
          </div>
        </>
      )}
    </div>
  );
}
