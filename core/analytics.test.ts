import { describe, expect, it } from 'vitest';
import {
  aggregateAnalytics,
  bucketDate,
  bucketLabel,
  daysBetween,
  defaultPeriodicity,
  iterBuckets,
  parseLocalDate,
  type AnalyticsFilters
} from './analytics';
import type { SongPlayHistoryRow } from './types';

function row(song: string, date: string, duration: number, start = 0): SongPlayHistoryRow {
  return {
    annotation_id: Math.floor(Math.random() * 1e9),
    file_id: 1,
    song_name: song,
    start_time: start,
    end_time: start + duration,
    filename: 'f.mid',
    date_recorded: date,
    created_at: 0,
    updated_at: 0
  };
}

describe('parseLocalDate', () => {
  it('rejects malformed and impossible dates', () => {
    expect(parseLocalDate('2026-03-04')).not.toBeNull();
    expect(parseLocalDate('not-a-date')).toBeNull();
    expect(parseLocalDate('2026-02-30')).toBeNull();
    expect(parseLocalDate('2026-13-01')).toBeNull();
  });
});

describe('bucketDate', () => {
  it('buckets days to themselves', () => {
    expect(bucketDate('2026-03-04', 'day')).toBe('2026-03-04');
  });

  it('starts weeks on Monday, mapping Sunday back', () => {
    // 2026-03-02 is a Monday, 2026-03-08 the following Sunday.
    expect(bucketDate('2026-03-02', 'week')).toBe('2026-03-02');
    expect(bucketDate('2026-03-04', 'week')).toBe('2026-03-02');
    expect(bucketDate('2026-03-08', 'week')).toBe('2026-03-02');
    expect(bucketDate('2026-03-09', 'week')).toBe('2026-03-09');
  });

  it('buckets months as YYYY-MM across year boundaries', () => {
    expect(bucketDate('2025-12-31', 'month')).toBe('2025-12');
    expect(bucketDate('2026-01-01', 'month')).toBe('2026-01');
  });

  it('returns null for bad dates', () => {
    expect(bucketDate('bogus', 'week')).toBeNull();
  });
});

describe('bucketLabel', () => {
  it('labels days, weeks and months', () => {
    expect(bucketLabel('2026-03-04', 'day')).toBe('Mar 4');
    expect(bucketLabel('2026-03-02', 'week')).toBe('Mar 2 wk');
    expect(bucketLabel('2026-03', 'month')).toBe("Mar '26");
  });
});

describe('iterBuckets', () => {
  it('fills every day with no gaps', () => {
    expect(iterBuckets('2026-03-01', '2026-03-03', 'day')).toEqual([
      '2026-03-01', '2026-03-02', '2026-03-03'
    ]);
  });

  it('steps weeks by 7 from the Monday of the start date', () => {
    expect(iterBuckets('2026-03-04', '2026-03-12', 'week')).toEqual([
      '2026-03-02', '2026-03-09'
    ]);
  });

  it('steps months across year boundaries', () => {
    expect(iterBuckets('2025-11-15', '2026-02-10', 'month')).toEqual([
      '2025-11', '2025-12', '2026-01', '2026-02'
    ]);
  });

  it('returns empty for a reversed or invalid range', () => {
    expect(iterBuckets('2026-03-05', '2026-03-01', 'day')).toEqual([]);
    expect(iterBuckets('bogus', '2026-03-01', 'day')).toEqual([]);
  });
});

describe('defaultPeriodicity', () => {
  it('picks day, week and month by range length', () => {
    expect(defaultPeriodicity('2026-01-01', '2026-01-20')).toBe('day');
    expect(defaultPeriodicity('2026-01-01', '2026-03-01')).toBe('week');
    expect(defaultPeriodicity('2025-01-01', '2026-09-01')).toBe('month');
  });

  it('falls back to week for bad input', () => {
    expect(defaultPeriodicity('bogus', '2026-01-01')).toBe('week');
  });
});

describe('daysBetween', () => {
  it('counts whole days and rejects bad input', () => {
    expect(daysBetween('2026-03-01', '2026-03-04')).toBe(3);
    expect(daysBetween('bogus', '2026-03-04')).toBeNull();
  });
});

describe('aggregateAnalytics', () => {
  const filters: AnalyticsFilters = {
    start: '2026-03-01',
    end: '2026-03-07',
    periodicity: 'day',
    topN: 5
  };

  it('ranks songs by annotated seconds, not session count', () => {
    const rows = [
      row('Short Many', '2026-03-02', 60),
      row('Short Many', '2026-03-03', 60),
      row('Short Many', '2026-03-04', 60),
      row('Long One', '2026-03-02', 600)
    ];
    const result = aggregateAnalytics(rows, filters);
    expect(result.totals.map((t) => t.song)).toEqual(['Long One', 'Short Many']);
    expect(result.totalSeconds).toBe(780);
    expect(result.distinctSongs).toBe(2);
    expect(result.activeDays).toBe(3);
  });

  it('fills empty buckets with zeros and aligns series', () => {
    const rows = [row('A', '2026-03-01', 100), row('A', '2026-03-07', 50)];
    const result = aggregateAnalytics(rows, filters);
    expect(result.buckets).toHaveLength(7);
    expect(result.series['A']).toEqual([100, 0, 0, 0, 0, 0, 50]);
  });

  it('skips out-of-range, invalid and non-positive rows', () => {
    const rows = [
      row('A', '2026-02-28', 100),
      row('A', '2026-03-08', 100),
      row('A', 'bogus-date', 100),
      row('A', '2026-03-02', 0),
      row('A', '2026-03-02', -5),
      row('A', '2026-03-03', 120)
    ];
    const result = aggregateAnalytics(rows, filters);
    expect(result.totals).toHaveLength(1);
    expect(result.totalSeconds).toBe(120);
    expect(result.heatmap).toEqual({ '2026-03-03': 120 });
  });

  it('tracks sessions, active days and last played per song', () => {
    const rows = [
      row('A', '2026-03-01', 100),
      row('A', '2026-03-01', 50),
      row('A', '2026-03-05', 25)
    ];
    const result = aggregateAnalytics(rows, filters);
    expect(result.totals[0]).toMatchObject({
      song: 'A',
      seconds: 175,
      sessions: 3,
      activeDays: 2,
      lastPlayed: '2026-03-05'
    });
  });

  it('aggregates weekly buckets within a day range', () => {
    const rows = [
      row('A', '2026-03-03', 100), // Tue → week of Mar 2
      row('A', '2026-03-08', 200) // Sun → week of Mar 2
    ];
    const result = aggregateAnalytics(rows, {
      start: '2026-03-01',
      end: '2026-03-14',
      periodicity: 'week',
      topN: 5
    });
    expect(result.buckets).toEqual(['2026-02-23', '2026-03-02', '2026-03-09']);
    expect(result.series['A']).toEqual([0, 300, 0]);
  });

  it('returns an empty result for a reversed range', () => {
    const result = aggregateAnalytics([row('A', '2026-03-02', 100)], {
      start: '2026-03-07',
      end: '2026-03-01',
      periodicity: 'day',
      topN: 5
    });
    expect(result.totals).toEqual([]);
    expect(result.buckets).toEqual([]);
    expect(result.totalSeconds).toBe(0);
  });
});
