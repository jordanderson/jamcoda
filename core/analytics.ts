/**
 * Practice analytics: bucketing and aggregation over annotated song segments.
 *
 * Pure and isomorphic (no I/O, no locale-dependent rendering): the Analytics
 * page feeds it `SongPlayHistoryRow`s and renders whatever comes back.
 * "When" is `date_recorded` (when the song was played), not `created_at`
 * (when it was labeled) — late labeling must not move practice history.
 */

import type { SongPlayHistoryRow } from './types';

export type Periodicity = 'day' | 'week' | 'month';

export interface AnalyticsFilters {
  /** Inclusive `YYYY-MM-DD` range start. */
  start: string;
  /** Inclusive `YYYY-MM-DD` range end. */
  end: string;
  periodicity: Periodicity;
  /** How many top songs the charts emphasize. */
  topN: number;
}

export interface SongTotal {
  song: string;
  seconds: number;
  sessions: number;
  activeDays: number;
  lastPlayed: string;
}

export interface AnalyticsResult {
  totals: SongTotal[];
  /** Bucket keys in chronological order (`YYYY-MM-DD` for day/week, `YYYY-MM` for month). */
  buckets: string[];
  /** Per-song seconds aligned with `buckets`. Includes every in-range song. */
  series: Record<string, number[]>;
  /** `YYYY-MM-DD` date to annotated seconds, for the consistency heatmap. */
  heatmap: Record<string, number>;
  totalSeconds: number;
  activeDays: number;
  distinctSongs: number;
}

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse `YYYY-MM-DD` as local midnight. Null when malformed or impossible. */
export function parseLocalDate(dateStr: string): Date | null {
  if (!DATE_RE.test(dateStr)) return null;
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  // Reject impossible dates (`2026-02-30` parses to Mar 2).
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const [y, m, d] = dateStr.split('-').map(Number);
  if (year !== y || month !== m || day !== d) return null;
  return date;
}

/** Format a local-midnight Date back to `YYYY-MM-DD`. */
export function toDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Bucket key for a recording date. Weeks start Monday: a Sunday belongs to
 * the week of the preceding Monday. Months key as `YYYY-MM`.
 */
export function bucketDate(dateStr: string, periodicity: Periodicity): string | null {
  const date = parseLocalDate(dateStr);
  if (!date) return null;
  if (periodicity === 'day') return dateStr;
  if (periodicity === 'month') return dateStr.slice(0, 7);
  const dow = (date.getDay() + 6) % 7; // Monday = 0 … Sunday = 6
  const monday = new Date(date);
  monday.setDate(date.getDate() - dow);
  return toDateStr(monday);
}

/** Short display label for a bucket key. Locale-independent. */
export function bucketLabel(bucket: string, periodicity: Periodicity): string {
  if (periodicity === 'month') {
    const [y, m] = bucket.split('-').map(Number);
    if (!y || !m) return bucket;
    return `${MONTH_ABBR[m - 1]} '${String(y).slice(2)}`;
  }
  const date = parseLocalDate(bucket);
  if (!date) return bucket;
  const label = `${MONTH_ABBR[date.getMonth()]} ${date.getDate()}`;
  return periodicity === 'week' ? `${label} wk` : label;
}

/**
 * Every bucket key covering `[start, end]` inclusive, chronological, with no
 * gaps — empty buckets render as zero-height slots so gaps read as gaps.
 */
export function iterBuckets(start: string, end: string, periodicity: Periodicity): string[] {
  const startDate = parseLocalDate(start);
  const endDate = parseLocalDate(end);
  if (!startDate || !endDate || startDate > endDate) return [];

  if (periodicity === 'day') {
    const out: string[] = [];
    const cursor = new Date(startDate);
    while (cursor <= endDate) {
      out.push(toDateStr(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }

  if (periodicity === 'week') {
    const first = bucketDate(start, 'week');
    if (!first) return [];
    const out: string[] = [];
    let cursor = parseLocalDate(first);
    while (cursor && toDateStr(cursor) <= end) {
      out.push(toDateStr(cursor));
      cursor = new Date(cursor);
      cursor.setDate(cursor.getDate() + 7);
    }
    return out;
  }

  const out: string[] = [];
  let year = startDate.getFullYear();
  let month = startDate.getMonth();
  const endYear = endDate.getFullYear();
  const endMonth = endDate.getMonth();
  while (year < endYear || (year === endYear && month <= endMonth)) {
    out.push(`${year}-${String(month + 1).padStart(2, '0')}`);
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return out;
}

/** Whole days between two `YYYY-MM-DD` dates, for auto-periodicity. */
export function daysBetween(start: string, end: string): number | null {
  const a = parseLocalDate(start);
  const b = parseLocalDate(end);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** Default bucket size for a range: day ≤ 35d, week ≤ 120d, else month. */
export function defaultPeriodicity(start: string, end: string): Periodicity {
  const days = daysBetween(start, end);
  if (days === null) return 'week';
  if (days > 120) return 'month';
  if (days > 35) return 'week';
  return 'day';
}

const EMPTY_RESULT: AnalyticsResult = {
  totals: [],
  buckets: [],
  series: {},
  heatmap: {},
  totalSeconds: 0,
  activeDays: 0,
  distinctSongs: 0
};

/**
 * Aggregate annotation rows into per-song totals, per-bucket series, and a
 * per-day heatmap. Rows outside `[start, end]`, with unparseable dates, or
 * with non-positive duration are skipped.
 */
export function aggregateAnalytics(
  rows: SongPlayHistoryRow[],
  filters: AnalyticsFilters
): AnalyticsResult {
  const buckets = iterBuckets(filters.start, filters.end, filters.periodicity);
  if (buckets.length === 0) return EMPTY_RESULT;
  const bucketIndex = new Map(buckets.map((key, index) => [key, index]));

  const perSong = new Map<string, { seconds: number; sessions: number; days: Set<string>; lastPlayed: string }>();
  const series = new Map<string, number[]>();
  const heatmap = new Map<string, number>();
  const activeDaySet = new Set<string>();
  let totalSeconds = 0;

  for (const row of rows) {
    if (!Number.isFinite(row.start_time) || !Number.isFinite(row.end_time)) continue;
    const duration = row.end_time - row.start_time;
    if (!(duration > 0)) continue;
    if (row.date_recorded < filters.start || row.date_recorded > filters.end) continue;
    const bucket = bucketDate(row.date_recorded, filters.periodicity);
    if (bucket === null) continue;
    const index = bucketIndex.get(bucket);
    if (index === undefined) continue;

    totalSeconds += duration;
    activeDaySet.add(row.date_recorded);
    heatmap.set(row.date_recorded, (heatmap.get(row.date_recorded) ?? 0) + duration);

    let entry = perSong.get(row.song_name);
    if (!entry) {
      entry = { seconds: 0, sessions: 0, days: new Set(), lastPlayed: row.date_recorded };
      perSong.set(row.song_name, entry);
    }
    entry.seconds += duration;
    entry.sessions += 1;
    entry.days.add(row.date_recorded);
    if (row.date_recorded > entry.lastPlayed) entry.lastPlayed = row.date_recorded;

    let songSeries = series.get(row.song_name);
    if (!songSeries) {
      songSeries = new Array(buckets.length).fill(0);
      series.set(row.song_name, songSeries);
    }
    songSeries[index] += duration;
  }

  const totals: SongTotal[] = [...perSong.entries()].map(([song, entry]) => ({
    song,
    seconds: entry.seconds,
    sessions: entry.sessions,
    activeDays: entry.days.size,
    lastPlayed: entry.lastPlayed
  }));
  totals.sort((a, b) => b.seconds - a.seconds || b.sessions - a.sessions || a.song.localeCompare(b.song));

  return {
    totals,
    buckets,
    series: Object.fromEntries(series),
    heatmap: Object.fromEntries(heatmap),
    totalSeconds,
    activeDays: activeDaySet.size,
    distinctSongs: perSong.size
  };
}
