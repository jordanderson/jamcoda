import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { formatDate, formatHoursMinutes } from '@/utils/format';
import type { SongTotal } from '@core/analytics';
import { songColor } from './songColor';

type SortKey = 'song' | 'seconds' | 'sessions' | 'lastPlayed';

interface AnalyticsTableProps {
  totals: SongTotal[];
  series: Record<string, number[]>;
  selectedSong: string | null;
  onSelectSong: (song: string | null) => void;
}

function Sparkline({ data }: { data: number[] }) {
  const width = 84;
  const height = 22;
  if (data.length === 0) return null;
  const max = Math.max(1, ...data);
  const step = data.length > 1 ? width / (data.length - 1) : 0;
  const points = data
    .map((value, i) => `${(i * step).toFixed(1)},${(height - 2 - (value / max) * (height - 4)).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={width} height={height} className="overflow-visible block mx-auto" aria-hidden>
      <polyline points={points} fill="none" stroke="#6b7280" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

export function AnalyticsTable({ totals, series, selectedSong, onSelectSong }: AnalyticsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('seconds');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const rows = useMemo(() => {
    const sorted = [...totals];
    sorted.sort((a, b) => {
      let cmp: number;
      switch (sortKey) {
        case 'song':
          cmp = a.song.localeCompare(b.song, undefined, { sensitivity: 'base' });
          break;
        case 'sessions':
          cmp = a.sessions - b.sessions;
          break;
        case 'lastPlayed':
          cmp = a.lastPlayed.localeCompare(b.lastPlayed);
          break;
        default:
          cmp = a.seconds - b.seconds;
      }
      if (cmp === 0) cmp = b.seconds - a.seconds;
      return sortDirection === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [totals, sortKey, sortDirection]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDirection(key === 'song' ? 'asc' : 'desc');
  };

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return null;
    return sortDirection === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5" />
      : <ArrowDown className="w-3.5 h-3.5" />;
  };

  const headerButton = (key: SortKey, label: string) => (
    <button
      onClick={() => handleSort(key)}
      className="inline-flex items-center gap-1 hover:text-gray-900 transition-colors"
    >
      {label}
      {sortIcon(key)}
    </button>
  );

  return (
    <div className="bg-white border rounded-lg overflow-hidden">
      <div className="px-5 pt-5 pb-3">
        <h2 className="text-lg font-bold text-gray-900">All songs in range</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Click a row to highlight that song in the charts.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 border-y">
            <tr className="text-left text-gray-600">
              <th className="px-4 py-3 font-semibold">{headerButton('song', 'Song')}</th>
              <th className="px-4 py-3 font-semibold text-right">{headerButton('seconds', 'Total')}</th>
              <th className="px-4 py-3 font-semibold text-right">{headerButton('sessions', 'Sessions')}</th>
              <th className="px-4 py-3 font-semibold text-right">Days</th>
              <th className="px-4 py-3 font-semibold text-right">{headerButton('lastPlayed', 'Last played')}</th>
              <th className="px-4 py-3 font-semibold text-center">Trend</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-gray-500" colSpan={6}>
                  No labels in this range.
                </td>
              </tr>
            )}
            {rows.map((entry) => {
              const isSelected = selectedSong === entry.song;
              return (
                <tr
                  key={entry.song}
                  onClick={() => onSelectSong(isSelected ? null : entry.song)}
                  style={isSelected ? { boxShadow: `inset 3px 0 0 ${songColor(entry.song)}`, backgroundColor: '#f9fafb' } : undefined}
                  className="cursor-pointer transition-colors hover:bg-gray-50"
                >
                  <td className="px-4 py-2.5 font-medium">
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                        style={{ backgroundColor: songColor(entry.song) }}
                      />
                      <a
                        href={`#/songs?song=${encodeURIComponent(entry.song)}`}
                        onClick={(event) => event.stopPropagation()}
                        title={`Open “${entry.song}” in Songs to play takes from every session`}
                        className="text-gray-900 hover:underline"
                      >
                        {entry.song}
                      </a>
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-700 text-right tabular-nums">
                    {formatHoursMinutes(entry.seconds)}
                  </td>
                  <td className="px-4 py-2.5 text-gray-700 text-right tabular-nums">{entry.sessions}</td>
                  <td className="px-4 py-2.5 text-gray-700 text-right tabular-nums">{entry.activeDays}</td>
                  <td className="px-4 py-2.5 text-gray-700 text-right">{formatDate(entry.lastPlayed)}</td>
                  <td className="px-4 py-2.5">
                    <Sparkline data={series[entry.song] ?? []} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
