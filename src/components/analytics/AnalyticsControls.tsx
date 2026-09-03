import type { Periodicity } from '@core/analytics';

export type DatePreset = '30d' | '90d' | '6m' | 'all' | 'custom';
export type PeriodicityChoice = Periodicity | 'auto';

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  '30d': 'Last 30d',
  '90d': 'Last 90d',
  '6m': 'Last 6m',
  all: 'All time',
  custom: 'Custom'
};

const PRESET_ORDER: DatePreset[] = ['30d', '90d', '6m', 'all', 'custom'];

const PERIODICITY_OPTIONS: { value: PeriodicityChoice; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' }
];

interface AnalyticsControlsProps {
  preset: DatePreset;
  onPresetChange: (preset: DatePreset) => void;
  customStart: string;
  customEnd: string;
  onCustomChange: (which: 'start' | 'end', value: string) => void;
  periodicity: PeriodicityChoice;
  onPeriodicityChange: (periodicity: PeriodicityChoice) => void;
  resolvedStart: string;
  resolvedEnd: string;
  minDate: string;
  maxDate: string;
}

export function AnalyticsControls({
  preset,
  onPresetChange,
  customStart,
  customEnd,
  onCustomChange,
  periodicity,
  onPeriodicityChange,
  resolvedStart,
  resolvedEnd,
  minDate,
  maxDate
}: AnalyticsControlsProps) {
  return (
    <div className="bg-white border rounded-lg p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-gray-700">Range</span>
        <div className="flex rounded-lg bg-gray-100 p-0.5">
          {PRESET_ORDER.map((option) => (
            <button
              key={option}
              onClick={() => onPresetChange(option)}
              aria-pressed={preset === option}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                preset === option
                  ? 'bg-gray-900 text-white'
                  : 'text-gray-700 hover:bg-gray-200'
              }`}
            >
              {DATE_PRESET_LABELS[option]}
            </button>
          ))}
        </div>

        <span className="text-sm font-medium text-gray-700 ml-2">By</span>
        <div className="flex rounded-lg bg-gray-100 p-0.5">
          {PERIODICITY_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => onPeriodicityChange(option.value)}
              aria-pressed={periodicity === option.value}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                periodicity === option.value
                  ? 'bg-gray-900 text-white'
                  : 'text-gray-700 hover:bg-gray-200'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {preset === 'custom' && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
          <label className="flex items-center gap-2">
            From
            <input
              type="date"
              value={customStart || resolvedStart}
              min={minDate}
              max={maxDate}
              onChange={(event) => onCustomChange('start', event.target.value)}
              className="px-2 py-1.5 border rounded-lg text-sm bg-white"
            />
          </label>
          <label className="flex items-center gap-2">
            To
            <input
              type="date"
              value={customEnd || resolvedEnd}
              min={minDate}
              max={maxDate}
              onChange={(event) => onCustomChange('end', event.target.value)}
              className="px-2 py-1.5 border rounded-lg text-sm bg-white"
            />
          </label>
        </div>
      )}
    </div>
  );
}
