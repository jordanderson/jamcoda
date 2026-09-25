import { listenStretches } from '@core/predictionEvidence';
import type { AnnotationInterval, SegmentBasis, SongSegment } from './songSegmentation';

/**
 * Scoring by what an annotation means in this library.
 *
 * An annotation marks a stretch of working on one song: repeated takes,
 * repeated sections and one-hand practice included, as long as it stays part of
 * the song. It stops when the playing turns into noodling, and ends on the
 * song's last notes, leaving out any flourish. On a complete file, unannotated
 * time therefore means no song: only noodling, flourishes and silence.
 *
 * Two annotations of the same song with a gap between them are two sessions,
 * and the gap is noodling. A prediction that joins them has called that
 * noodling the song, and costs a split to review. A restart inside one
 * annotation is not a boundary at all. So instead of matching predictions to
 * annotations as takes, this divides each complete file's time into what the
 * prediction got right and the ways it went wrong, and counts the edits a
 * review would need.
 */

/**
 * A gap shorter than this between two annotations of one song is a pause, not
 * noodling: the two annotations are scored as one session.
 */
export const MIN_SESSION_GAP_SEC = 3;
/** A same-song prediction must overlap a session by this much to count as one of its pieces. */
export const MIN_SESSION_PIECE_SEC = 5;
/**
 * Same-song gap lengths are reported in these bins. Every window across a gap
 * shorter than the model's window (6s by default) also contains some of the
 * song, so bridging such a gap is a limit of the window length, not a model
 * mistake.
 */
export const GAP_LENGTH_BINS_SEC = [MIN_SESSION_GAP_SEC, 6, 12, 30, Infinity] as const;

export interface SameSongGap {
  songName: string;
  startSec: number;
  lengthSec: number;
  /** A single prediction of the song spans the gap, overlapping both sessions. */
  bridged: boolean;
  /** For a bridged gap, the basis of the bridging prediction's parts covering most of it. */
  mainBasis?: SegmentBasis;
}

/** Where predicted song time falls, in the categories the row reports. */
export type TimeCategory = 'correct' | 'wrongSong' | 'gapFill' | 'overrun' | 'strayBleed';

/** Seconds of predicted song time by category and by how the decoder reached it (`SongSegment.parts`). */
export type TimeByBasis = Record<TimeCategory, Partial<Record<SegmentBasis, number>>>;

const emptyTimeByBasis = (): TimeByBasis =>
  ({ correct: {}, wrongSong: {}, gapFill: {}, overrun: {}, strayBleed: {} });

export interface SessionScoreRow {
  fileId: number;
  /** Time under an annotation. */
  annotatedSec: number;
  /** Time from 0 to the end of the file under no annotation. */
  unannotatedSec: number;
  /** Annotated time predicted as its own song. */
  correctSec: number;
  /** Annotated time predicted as a different song. */
  wrongSongSec: number;
  /** Annotated time with no prediction. */
  missedSec: number;
  /** Unannotated time predicted as a song: `gapFillSec + overrunSec + strayBleedSec`. */
  bleedSec: number;
  /** Bleed inside a gap between two sessions of one song, predicted as that song. */
  gapFillSec: number;
  /** Other bleed predicted as the song of an adjacent session: a session run long or started early. */
  overrunSec: number;
  /** Bleed predicted as a song neither neighbor is. */
  strayBleedSec: number;
  sessions: number;
  /** Sessions covered at least half by predictions of their own song. */
  sessionsFound: number;
  /** Sessions covered by two or more separate predictions of their own song; each costs a merge. */
  sessionsSplit: number;
  /** Consecutive sessions of one song separated by at least `MIN_SESSION_GAP_SEC`. */
  sameSongGaps: number;
  /** Of those, gaps a single prediction spans, overlapping both sessions; each costs a split. */
  gapsBridged: number;
  /** Every same-song gap, for reading bridging by gap length. */
  gaps: SameSongGap[];
  /** Present when the segments carry `parts`. */
  timeByBasis: TimeByBasis;
  /**
   * Every non-anchor part: how long it is, how much of it lies in a gap between
   * two sessions of its song, and how much of it is correct. These are the
   * stretches a review could be pointed at.
   */
  weakParts: Array<{
    basis: SegmentBasis; lengthSec: number; gapSec: number; correctSec: number; meanRank?: number;
  }>;
  /** Stretches the review UI flags as worth a listen (`listenStretches`), with how much of each is wrong. */
  listenFlags: Array<{ lengthSec: number; errorSec: number }>;
  predictedSegments: number;
  /** Predicted segments less than half of whose time is correct: each is a delete or a relabel. */
  unsupportedSegments: number;
  /**
   * Estimated review edits: a split per bridged gap, a merge per split session,
   * a new annotation per session not found, and a delete or relabel per
   * unsupported segment. Boundary trims are counted in seconds, not here.
   */
  reviewEdits: number;
}

export type SessionScoreSummary = Omit<SessionScoreRow, 'fileId' | 'gaps' | 'weakParts' | 'listenFlags'> & {
  /** Flags the review UI would show, and how many of them cover at least two seconds of error. */
  listenFlags: { flags: number; coveringError: number };
  /** Bridged same-song gaps by the basis covering most of each. */
  bridgedGapsByBasis: Partial<Record<SegmentBasis, number>>;
  files: number;
  /** Same-song gaps and how many were bridged, by `GAP_LENGTH_BINS_SEC`. */
  gapsByLength: Array<{ fromSec: number; toSec: number | null; gaps: number; bridged: number }>;
  /** Share of annotated time predicted as its own song. */
  correctShare: number;
  /** Share of unannotated time predicted as a song. */
  bleedShare: number;
};

/** Annotations in time order, with same-song neighbors a pause apart joined into one session. */
function joinPauses(annotations: AnnotationInterval[]): AnnotationInterval[] {
  const sessions: AnnotationInterval[] = [];
  for (const annotation of [...annotations].sort((a, b) => a.startTime - b.startTime)) {
    const last = sessions.at(-1);
    if (last && last.songName === annotation.songName && annotation.startTime - last.endTime < MIN_SESSION_GAP_SEC) {
      last.endTime = Math.max(last.endTime, annotation.endTime);
    } else {
      sessions.push({ ...annotation });
    }
  }
  return sessions;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

export function scoreSessions(
  fileId: number,
  annotations: AnnotationInterval[],
  segments: SongSegment[],
  fileEndSec: number
): SessionScoreRow {
  const sessions = joinPauses(annotations);
  const endSec = Math.max(
    fileEndSec,
    ...sessions.map((s) => s.endTime),
    ...segments.map((s) => s.endTime),
    0
  );

  const row: SessionScoreRow = {
    fileId, annotatedSec: 0, unannotatedSec: 0, correctSec: 0, wrongSongSec: 0, missedSec: 0,
    bleedSec: 0, gapFillSec: 0, overrunSec: 0, strayBleedSec: 0,
    sessions: sessions.length, sessionsFound: 0, sessionsSplit: 0, sameSongGaps: 0, gapsBridged: 0, gaps: [],
    timeByBasis: emptyTimeByBasis(),
    weakParts: [],
    listenFlags: [],
    predictedSegments: segments.length, unsupportedSegments: 0, reviewEdits: 0
  };

  // Every boundary of either side splits the timeline into pieces that each
  // sit under one fixed set of annotations and at most one prediction.
  const cuts = new Set<number>([0, endSec]);
  for (const s of [...sessions, ...segments, ...segments.flatMap((segment) => segment.parts ?? [])]) {
    cuts.add(Math.min(endSec, Math.max(0, s.startTime)));
    cuts.add(Math.min(endSec, Math.max(0, s.endTime)));
  }
  const basisAt = (segment: SongSegment, mid: number): SegmentBasis | undefined =>
    segment.parts?.find((part) => part.startTime <= mid && mid < part.endTime)?.basis;
  const addBasis = (category: TimeCategory, segment: SongSegment, mid: number, length: number) => {
    const basis = basisAt(segment, mid);
    if (!basis) return;
    const bucket = row.timeByBasis[category];
    bucket[basis] = (bucket[basis] ?? 0) + length;
  };
  const points = [...cuts].sort((a, b) => a - b);
  const correctBySegment = new Array<number>(segments.length).fill(0);

  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i];
    const to = points[i + 1];
    const length = to - from;
    if (length <= 0) continue;
    const mid = (from + to) / 2;
    const under = sessions.filter((s) => s.startTime <= mid && mid < s.endTime);
    const segmentIndex = segments.findIndex((s) => s.startTime <= mid && mid < s.endTime);
    const predicted = segmentIndex >= 0 ? segments[segmentIndex].songName : null;

    if (under.length > 0) {
      row.annotatedSec += length;
      if (predicted === null) row.missedSec += length;
      else if (under.some((s) => s.songName === predicted)) {
        row.correctSec += length;
        correctBySegment[segmentIndex] += length;
        addBasis('correct', segments[segmentIndex], mid, length);
      } else {
        row.wrongSongSec += length;
        addBasis('wrongSong', segments[segmentIndex], mid, length);
      }
      continue;
    }

    row.unannotatedSec += length;
    if (predicted === null) continue;
    row.bleedSec += length;
    let previous: AnnotationInterval | undefined;
    for (const s of sessions) if (s.endTime <= mid && (!previous || s.endTime > previous.endTime)) previous = s;
    const next = sessions.find((s) => s.startTime >= mid);
    let category: TimeCategory;
    if (previous && next && previous.songName === next.songName && predicted === previous.songName) {
      row.gapFillSec += length;
      category = 'gapFill';
    } else if (predicted === previous?.songName || predicted === next?.songName) {
      row.overrunSec += length;
      category = 'overrun';
    } else {
      row.strayBleedSec += length;
      category = 'strayBleed';
    }
    addBasis(category, segments[segmentIndex], mid, length);
  }

  for (const session of sessions) {
    const own = segments.filter((s) => s.songName === session.songName);
    const covered = own.reduce((sum, s) => sum + overlap(s.startTime, s.endTime, session.startTime, session.endTime), 0);
    if (covered >= (session.endTime - session.startTime) / 2) row.sessionsFound++;
    const pieces = own.filter(
      (s) => overlap(s.startTime, s.endTime, session.startTime, session.endTime) >= MIN_SESSION_PIECE_SEC
    );
    if (pieces.length >= 2) row.sessionsSplit++;
  }

  for (let i = 0; i + 1 < sessions.length; i++) {
    const left = sessions[i];
    const right = sessions[i + 1];
    if (left.songName !== right.songName) continue;
    row.sameSongGaps++;
    const bridging = segments.find((s) => s.songName === left.songName
      && s.startTime < left.endTime && s.endTime > right.startTime);
    const bridged = Boolean(bridging);
    if (bridged) row.gapsBridged++;
    const coverage = new Map<SegmentBasis, number>();
    for (const part of bridging?.parts ?? []) {
      const covered = overlap(part.startTime, part.endTime, left.endTime, right.startTime);
      if (covered > 0) coverage.set(part.basis, (coverage.get(part.basis) ?? 0) + covered);
    }
    const mainBasis = [...coverage.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    row.gaps.push({
      songName: left.songName, startSec: left.endTime, lengthSec: right.startTime - left.endTime, bridged,
      ...(mainBasis ? { mainBasis } : {})
    });
  }

  segments.forEach((segment, index) => {
    const duration = segment.endTime - segment.startTime;
    if (duration > 0 && correctBySegment[index] < duration / 2) row.unsupportedSegments++;
  });

  const sameSongGaps: Array<{ songName: string; from: number; to: number }> = [];
  for (let i = 0; i + 1 < sessions.length; i++) {
    if (sessions[i].songName === sessions[i + 1].songName) {
      sameSongGaps.push({ songName: sessions[i].songName, from: sessions[i].endTime, to: sessions[i + 1].startTime });
    }
  }
  for (const segment of segments) {
    for (const part of segment.parts ?? []) {
      if (part.basis === 'anchor') continue;
      const gapSec = sameSongGaps
        .filter((gap) => gap.songName === segment.songName)
        .reduce((sum, gap) => sum + overlap(part.startTime, part.endTime, gap.from, gap.to), 0);
      const correctSec = sessions
        .filter((session) => session.songName === segment.songName)
        .reduce((sum, session) => sum + overlap(part.startTime, part.endTime, session.startTime, session.endTime), 0);
      row.weakParts.push({
        basis: part.basis, lengthSec: part.endTime - part.startTime, gapSec, correctSec,
        ...(part.meanRank !== undefined ? { meanRank: part.meanRank } : {})
      });
    }
  }

  for (const segment of segments) {
    for (const stretch of listenStretches(segment.parts ?? [])) {
      const correctSec = sessions
        .filter((session) => session.songName === segment.songName)
        .reduce((sum, session) => sum + overlap(stretch.startTime, stretch.endTime, session.startTime, session.endTime), 0);
      const lengthSec = stretch.endTime - stretch.startTime;
      row.listenFlags.push({ lengthSec, errorSec: lengthSec - correctSec });
    }
  }

  row.reviewEdits = row.gapsBridged + row.sessionsSplit
    + (row.sessions - row.sessionsFound) + row.unsupportedSegments;
  return row;
}

export function summarizeSessions(rows: SessionScoreRow[]): SessionScoreSummary {
  const summary: SessionScoreSummary = {
    files: rows.length, annotatedSec: 0, unannotatedSec: 0, correctSec: 0, wrongSongSec: 0, missedSec: 0,
    bleedSec: 0, gapFillSec: 0, overrunSec: 0, strayBleedSec: 0, sessions: 0, sessionsFound: 0,
    sessionsSplit: 0, sameSongGaps: 0, gapsBridged: 0, predictedSegments: 0, unsupportedSegments: 0,
    reviewEdits: 0, correctShare: 0, bleedShare: 0, timeByBasis: emptyTimeByBasis(), bridgedGapsByBasis: {},
    listenFlags: { flags: 0, coveringError: 0 },
    gapsByLength: GAP_LENGTH_BINS_SEC.slice(0, -1).map((fromSec, index) => {
      const toSec = GAP_LENGTH_BINS_SEC[index + 1];
      return { fromSec, toSec: Number.isFinite(toSec) ? toSec : null, gaps: 0, bridged: 0 };
    })
  };
  for (const row of rows) {
    for (const key of SESSION_TOTAL_KEYS) summary[key] += row[key];
    for (const [category, bases] of Object.entries(row.timeByBasis ?? {}) as Array<[TimeCategory, TimeByBasis[TimeCategory]]>) {
      for (const [basis, sec] of Object.entries(bases) as Array<[SegmentBasis, number]>) {
        summary.timeByBasis[category][basis] = (summary.timeByBasis[category][basis] ?? 0) + sec;
      }
    }
    for (const flag of row.listenFlags ?? []) {
      summary.listenFlags.flags++;
      if (flag.errorSec >= 2) summary.listenFlags.coveringError++;
    }
    for (const gap of row.gaps ?? []) {
      if (gap.bridged && gap.mainBasis) {
        summary.bridgedGapsByBasis[gap.mainBasis] = (summary.bridgedGapsByBasis[gap.mainBasis] ?? 0) + 1;
      }
      const bin = summary.gapsByLength.find((b) => gap.lengthSec >= b.fromSec && (b.toSec === null || gap.lengthSec < b.toSec));
      if (!bin) continue;
      bin.gaps++;
      if (gap.bridged) bin.bridged++;
    }
  }
  summary.correctShare = summary.annotatedSec > 0 ? summary.correctSec / summary.annotatedSec : 0;
  summary.bleedShare = summary.unannotatedSec > 0 ? summary.bleedSec / summary.unannotatedSec : 0;
  return summary;
}

/** The additive fields of a row, which sum across files. */
export const SESSION_TOTAL_KEYS = [
  'annotatedSec', 'unannotatedSec', 'correctSec', 'wrongSongSec', 'missedSec',
  'bleedSec', 'gapFillSec', 'overrunSec', 'strayBleedSec',
  'sessions', 'sessionsFound', 'sessionsSplit', 'sameSongGaps', 'gapsBridged',
  'predictedSegments', 'unsupportedSegments', 'reviewEdits'
] as const satisfies ReadonlyArray<keyof SessionScoreRow>;
