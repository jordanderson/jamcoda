/**
 * Note-level boundary snapping, cadence detection, and flourish trimming.
 *
 * Sliding-window ML predictions produce coarse segment boundaries on a
 * window-step grid (e.g. 1-second steps, window centers), which leaves
 * pre-song dead air, cuts through active notes, or extends across extraneous
 * ending flourishes (arpeggios).
 *
 * This pure module provides:
 * 1. Note-onset / acoustic-release boundary snapping.
 * 2. Ending cadence chord identification and extraneous flourish detection.
 * 3. Segment boundary refinement combining both.
 */

export interface BoundaryNote {
  pitch?: number | null;
  velocity?: number | null;
  startTime?: number;
  endTime?: number;
  startSec?: number;
  endSec?: number;
  acousticEndSec?: number;
}

export function getNoteStart(note: BoundaryNote): number {
  return note.startTime ?? note.startSec ?? 0;
}

export function getNoteEnd(note: BoundaryNote): number {
  return note.acousticEndSec ?? note.endSec ?? note.endTime ?? 0;
}

export interface CadenceInfo {
  timeSec: number;
  endSec: number;
  pitches: number[];
  noteCount: number;
}

export interface CadenceFlourishInfo {
  cadence: CadenceInfo;
  flourishStart: number;
  flourishEnd: number;
  flourishNoteCount: number;
  flourishPitchSpan: number;
  trimmedEndTime: number;
}

export interface BoundarySnapOptions {
  /** Maximum distance to search for a phrase onset (default 1.5s). */
  maxSnapGapSec?: number;
  /** Whether to trim extraneous ending flourishes (default true). */
  trimFlourish?: boolean;
}

/**
 * Detect if an interval ends with a cadence chord followed by an extraneous
 * flourish (e.g. a rapid multi-octave arpeggio, scale sweep, or unmetered noodling).
 */
export function detectCadenceAndFlourish(
  startTime: number,
  endTime: number,
  notes: BoundaryNote[],
  options: {
    searchWindowSec?: number;
    minCadenceVoices?: number;
    minFlourishNotes?: number;
    minFlourishSpan?: number;
  } = {}
): CadenceFlourishInfo | null {
  if (endTime <= startTime || notes.length === 0) return null;

  const searchWindowSec = options.searchWindowSec ?? 6.0;
  const minCadenceVoices = options.minCadenceVoices ?? 3;
  const minFlourishNotes = options.minFlourishNotes ?? 4;
  const minFlourishSpan = options.minFlourishSpan ?? 18; // 1.5 octaves

  const minT = Math.max(startTime, endTime - searchWindowSec);
  const maxT = endTime + 4.0;

  // Filter and sort candidate notes in the tail region
  const tailNotes = notes
    .filter((n) => getNoteStart(n) >= minT && getNoteStart(n) <= maxT)
    .sort((a, b) => getNoteStart(a) - getNoteStart(b));

  if (tailNotes.length < minCadenceVoices + minFlourishNotes) return null;

  // 1. Identify chord clusters: notes struck almost simultaneously (within 0.08s)
  const clusters: CadenceInfo[] = [];
  let i = 0;
  while (i < tailNotes.length) {
    const root = tailNotes[i];
    const rootStart = getNoteStart(root);
    if (rootStart > endTime + 1.0) break;

    const chordNotes: BoundaryNote[] = [root];
    let j = i + 1;
    while (j < tailNotes.length && getNoteStart(tailNotes[j]) - rootStart <= 0.08) {
      chordNotes.push(tailNotes[j]);
      j++;
    }

    if (chordNotes.length >= minCadenceVoices) {
      const clusterEnd = Math.max(...chordNotes.map(getNoteEnd));
      const pitches = chordNotes
        .map((n) => n.pitch)
        .filter((p): p is number => p != null);

      clusters.push({
        timeSec: rootStart,
        endSec: clusterEnd,
        pitches,
        noteCount: chordNotes.length
      });
      i = j;
    } else {
      i++;
    }
  }

  if (clusters.length === 0) return null;

  // Candidate cadence chords must start before or immediately around endTime
  const cadences = clusters.filter((c) => c.timeSec <= endTime + 0.5);
  if (cadences.length === 0) return null;

  const cadence = cadences[cadences.length - 1];

  // Notes occurring after the cadence chord onset
  const postNotes = tailNotes.filter((n) => getNoteStart(n) > cadence.timeSec + 0.15);
  if (postNotes.length < minFlourishNotes) return null;

  const validPitches = postNotes
    .map((n) => n.pitch)
    .filter((p): p is number => p != null);

  if (validPitches.length < minFlourishNotes) return null;

  const minPitch = Math.min(...validPitches);
  const maxPitch = Math.max(...validPitches);
  const pitchSpan = maxPitch - minPitch;

  // Check rapid succession (inter-onset intervals < 0.35s)
  let rapidCount = 0;
  for (let k = 0; k < postNotes.length - 1; k++) {
    const ioi = getNoteStart(postNotes[k + 1]) - getNoteStart(postNotes[k]);
    if (ioi < 0.35) rapidCount++;
  }
  const rapidFraction = rapidCount / Math.max(1, postNotes.length - 1);

  if (pitchSpan >= minFlourishSpan && rapidFraction >= 0.65) {
    const flourishStart = getNoteStart(postNotes[0]);
    const flourishEnd = Math.max(...postNotes.map(getNoteEnd));

    return {
      cadence,
      flourishStart,
      flourishEnd,
      flourishNoteCount: postNotes.length,
      flourishPitchSpan: pitchSpan,
      trimmedEndTime: Math.min(cadence.endSec, flourishStart)
    };
  }

  return null;
}

/**
 * Snap a segment's start and end times to the nearest physical note onsets
 * and acoustic offsets.
 */
export function snapSegmentBoundaries(
  startTime: number,
  endTime: number,
  notes: BoundaryNote[],
  options: BoundarySnapOptions = {}
): { startTime: number; endTime: number; trimmedFlourish?: CadenceFlourishInfo | null } {
  if (endTime <= startTime || notes.length === 0) {
    return { startTime, endTime, trimmedFlourish: null };
  }

  const maxGap = options.maxSnapGapSec ?? 1.5;
  let effectiveEnd = endTime;
  let flourishInfo: CadenceFlourishInfo | null = null;

  // 1. Trim trailing flourish if enabled
  if (options.trimFlourish !== false) {
    flourishInfo = detectCadenceAndFlourish(startTime, effectiveEnd, notes);
    if (flourishInfo) {
      effectiveEnd = flourishInfo.trimmedEndTime;
    }
  }

  // 2. Start boundary snapping:
  // Case A: Dead air before first note: if no note is sounding at startTime,
  // snap to the first note onset in [startTime, startTime + maxGap].
  // Case B: In medias res: snap to nearest onset in [startTime - 0.5, startTime + 0.5].
  let snappedStart = startTime;
  const activeAtStart = notes.some(
    (n) => getNoteStart(n) <= startTime && getNoteEnd(n) > startTime
  );

  if (!activeAtStart) {
    const upcoming = notes
      .filter((n) => getNoteStart(n) >= startTime && getNoteStart(n) <= startTime + maxGap)
      .sort((a, b) => getNoteStart(a) - getNoteStart(b));

    if (upcoming.length > 0) {
      snappedStart = getNoteStart(upcoming[0]);
    } else {
      const recent = notes
        .filter((n) => getNoteStart(n) >= startTime - 0.5 && getNoteStart(n) <= startTime)
        .sort((a, b) => getNoteStart(b) - getNoteStart(a));
      if (recent.length > 0) {
        snappedStart = getNoteStart(recent[0]);
      }
    }
  } else {
    const candidates = notes
      .filter((n) => Math.abs(getNoteStart(n) - startTime) <= 0.6)
      .sort((a, b) => Math.abs(getNoteStart(a) - startTime) - Math.abs(getNoteStart(b) - startTime));

    if (candidates.length > 0) {
      snappedStart = getNoteStart(candidates[0]);
    }
  }

  // 3. End boundary snapping:
  // Snap to the acoustic release of the last sounding note that belongs to this phrase
  let snappedEnd = effectiveEnd;
  const upperCutoff = flourishInfo ? effectiveEnd + 0.05 : effectiveEnd + 0.5;
  const phraseNotes = notes.filter(
    (n) => getNoteStart(n) >= snappedStart && getNoteStart(n) <= upperCutoff
  );

  if (phraseNotes.length > 0) {
    const lastAcousticEnd = Math.max(...phraseNotes.map(getNoteEnd));
    if (Math.abs(lastAcousticEnd - effectiveEnd) <= maxGap) {
      snappedEnd = lastAcousticEnd;
    } else if (lastAcousticEnd < effectiveEnd) {
      snappedEnd = lastAcousticEnd;
    }
  }

  // Ensure valid interval
  if (snappedEnd <= snappedStart) {
    return { startTime, endTime: effectiveEnd, trimmedFlourish: flourishInfo };
  }

  return {
    startTime: snappedStart,
    endTime: snappedEnd,
    trimmedFlourish: flourishInfo
  };
}
