import { useMemo, useState } from 'react';
import { AlertCircle, Clock3, Disc3, Flame, Trophy } from 'lucide-react';
import { useSongPlayHistory } from '@/hooks/useAnnotations';
import { formatHoursMinutes } from '@/utils/format';
import {
  aggregateAnalytics,
  defaultPeriodicity,
  parseLocalDate,
  toDateStr,
  type Periodicity
} from '@core/analytics';
import {
  AnalyticsControls,
  type DatePreset,
  type PeriodicityChoice
} from './AnalyticsControls';
import { TopSongsChart } from './TopSongsChart';
import { TrendChart } from './TrendChart';
import { AnalyticsTable } from './AnalyticsTable';
import { errorMessage } from '@core/errors';

const PRESET_DAYS: Record<Exclude<DatePreset, 'all' | 'custom'>, number> = {
  '30d': 30,
  '90d': 90,
  '6m': 182
};

function shiftDate(dateStr: string, days: number): string {
  const date = parseLocalDate(dateStr);
  if (!date) return dateStr;
  date.setDate(date.getDate() + days);
  return toDateStr(date);
}

function todayStr(): string {
  return toDateStr(new Date());
}

export function AnalyticsPage() {
  const { data, isLoading, error } = useSongPlayHistory();
  const [preset, setPreset] = useState<DatePreset>('90d');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [periodicityChoice, setPeriodicityChoice] = useState<PeriodicityChoice>('auto');
  const [topN, setTopN] = useState(10);
  const [selectedSong, setSelectedSong] = useState<string | null>(null);

  const rows = useMemo(() => data?.songs ?? [], [data?.songs]);

  const extent = useMemo(() => {
    if (rows.length === 0) {
      const today = todayStr();
      return { min: shiftDate(today, -89), max: today, empty: true as const };
    }
    let min = rows[0].date_recorded;
    let max = rows[0].date_recorded;
    for (const row of rows) {
      if (row.date_recorded < min) min = row.date_recorded;
      if (row.date_recorded > max) max = row.date_recorded;
    }
    return { min, max, empty: false as const };
  }, [rows]);

  const range = useMemo(() => {
    if (preset === 'all' || extent.empty) return { start: extent.min, end: extent.max };
    if (preset === 'custom') {
      const start = customStart || extent.min;
      const end = customEnd || extent.max;
      return start <= end ? { start, end } : { start: end, end: start };
    }
    const end = extent.max;
    return { start: shiftDate(end, -(PRESET_DAYS[preset] - 1)), end };
  }, [preset, customStart, customEnd, extent]);

  const periodicity: Periodicity = periodicityChoice === 'auto'
    ? defaultPeriodicity(range.start, range.end)
    : periodicityChoice;

  const result = useMemo(
    () => aggregateAnalytics(rows, { ...range, periodicity, topN }),
    [rows, range, periodicity, topN]
  );

  const topSong = result.totals[0] ?? null;
  const topShare = topSong && result.totalSeconds > 0
    ? Math.round((topSong.seconds / result.totalSeconds) * 100)
    : 0;

  const handleCustomChange = (which: 'start' | 'end', value: string) => {
    if (which === 'start') setCustomStart(value);
    else setCustomEnd(value);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  const kpis = [
    {
      icon: Clock3,
      label: 'Practice time',
      value: formatHoursMinutes(result.totalSeconds),
      hint: `${result.activeDays} active day${result.activeDays === 1 ? '' : 's'}`
    },
    {
      icon: Disc3,
      label: 'Songs touched',
      value: String(result.distinctSongs),
      hint: topSong ? `top: ${topSong.song}` : 'no songs in range'
    },
    {
      icon: Flame,
      label: 'Active days',
      value: String(result.activeDays),
      hint: result.activeDays > 0
        ? `${formatHoursMinutes(result.totalSeconds / Math.max(1, result.activeDays))} / day`
        : 'no practice in range'
    },
    {
      icon: Trophy,
      label: 'Top song',
      value: topSong ? topSong.song : '—',
      hint: topSong ? `${formatHoursMinutes(topSong.seconds)} · ${topShare}% of time` : 'no songs in range'
    }
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Analytics</h1>
        <p className="text-gray-600 mt-1">
          Which songs you&apos;ve been working on, and when — ranked by annotated time on recording dates.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-red-700 flex-shrink-0" />
          <p className="text-red-700 text-sm">
            {errorMessage(error, 'Failed to load analytics')}
          </p>
        </div>
      )}

      <AnalyticsControls
        preset={preset}
        onPresetChange={setPreset}
        customStart={customStart}
        customEnd={customEnd}
        onCustomChange={handleCustomChange}
        periodicity={periodicityChoice}
        onPeriodicityChange={setPeriodicityChoice}
        resolvedStart={range.start}
        resolvedEnd={range.end}
        minDate={extent.min}
        maxDate={extent.max}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="bg-white border rounded-lg p-4">
              <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500 uppercase tracking-wide">
                <Icon className="w-3.5 h-3.5" />
                {kpi.label}
              </div>
              <div className="mt-1 text-2xl font-bold text-gray-900 truncate" title={kpi.value}>
                {kpi.value}
              </div>
              <div className="text-xs text-gray-500 truncate" title={kpi.hint}>
                {kpi.hint}
              </div>
            </div>
          );
        })}
      </div>

      <TopSongsChart
        totals={result.totals}
        topN={topN}
        onTopNChange={setTopN}
        selectedSong={selectedSong}
        onSelectSong={setSelectedSong}
      />

      <TrendChart
        buckets={result.buckets}
        periodicity={periodicity}
        series={result.series}
        topSongs={result.totals.map((entry) => entry.song)}
        selectedSong={selectedSong}
      />

      <AnalyticsTable
        totals={result.totals}
        series={result.series}
        selectedSong={selectedSong}
        onSelectSong={setSelectedSong}
      />
    </div>
  );
}
