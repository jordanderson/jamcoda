import { ExternalLink } from 'lucide-react';
import { formatHoursMinutes } from '@/utils/format';
import type { SongTotal } from '@core/analytics';
import { songColor } from './songColor';

interface TopSongsChartProps {
  totals: SongTotal[];
  topN: number;
  onTopNChange: (topN: number) => void;
  selectedSong: string | null;
  onSelectSong: (song: string | null) => void;
}

const TOP_N_OPTIONS = [5, 10, 25];

export function TopSongsChart({
  totals,
  topN,
  onTopNChange,
  selectedSong,
  onSelectSong
}: TopSongsChartProps) {
  const visible = totals.slice(0, topN);
  const maxSeconds = visible.length > 0 ? visible[0].seconds : 1;

  return (
    <div className="bg-white border rounded-lg p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="text-lg font-bold text-gray-900">Top songs by practice time</h2>
        <div className="flex rounded-lg bg-gray-100 p-0.5">
          {TOP_N_OPTIONS.map((option) => (
            <button
              key={option}
              onClick={() => onTopNChange(option)}
              aria-pressed={topN === option}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                topN === option
                  ? 'bg-gray-900 text-white'
                  : 'text-gray-700 hover:bg-gray-200'
              }`}
            >
              Top {option}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 && (
        <p className="text-sm text-gray-500">No labeled songs in this range.</p>
      )}

      <div className="space-y-2.5">
        {visible.map((entry) => {
          const isSelected = selectedSong === entry.song;
          const accent = songColor(entry.song);
          return (
            <div
              key={entry.song}
              style={isSelected ? { boxShadow: `inset 0 0 0 2px ${accent}`, backgroundColor: '#f9fafb' } : undefined}
              className="w-full rounded-lg transition-colors hover:bg-gray-50 flex items-stretch gap-1 pr-1"
            >
              <button
                onClick={() => onSelectSong(isSelected ? null : entry.song)}
                title={`${entry.song} — ${formatHoursMinutes(entry.seconds)} across ${entry.sessions} session${entry.sessions === 1 ? '' : 's'}. Click to ${isSelected ? 'clear' : 'highlight'} in the trend below.`}
                className="flex-1 min-w-0 text-left px-3 py-2"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium truncate text-gray-900">
                    {entry.song}
                  </span>
                  <span className="text-sm whitespace-nowrap text-gray-600">
                    {formatHoursMinutes(entry.seconds)}
                    <span className="ml-2 text-xs text-gray-400">
                      {entry.sessions}×
                    </span>
                  </span>
                </div>
                <div className="mt-1.5 h-2.5 rounded-full overflow-hidden bg-gray-100">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.max(2, (entry.seconds / maxSeconds) * 100)}%`,
                      backgroundColor: accent
                    }}
                  />
                </div>
              </button>
              <a
                href={`#/songs?song=${encodeURIComponent(entry.song)}`}
                title={`Open “${entry.song}” in Songs to play takes from every session`}
                aria-label={`Open ${entry.song} in Songs`}
                className="self-center p-2 rounded-lg text-gray-400 hover:text-gray-900 hover:bg-gray-200 transition-colors shrink-0"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          );
        })}
      </div>

      {selectedSong && (
        <button
          onClick={() => onSelectSong(null)}
          className="mt-3 text-xs text-gray-600 hover:text-gray-900 underline"
        >
          Clear “{selectedSong}” highlight
        </button>
      )}
    </div>
  );
}
