/**
 * Turning a recording into labeled feature windows.
 *
 * One window is `windowSec` of playing summarized as the numbers
 * `featureNamesFor(config)` names; windows step forward by `stepSec` and take
 * the label of whatever is sounding at their center.
 */
import { clamp, roundTo } from '@core/cli/args';
import {
  CHROMA_SIZE,
  NO_SONG_LABEL,
  POLYPHONY_BIN_SEC,
  REGULARITY_BIN_SEC,
  type AnnotatedMidiFile,
  type AnnotationInterval,
  type NoteEvent,
  type TrainConfig,
  type WindowSample
} from './types';

export function buildWindowStarts(maxTime: number, windowSec: number, stepSec: number): number[] {
  if (maxTime <= 0) return [0];

  const maxStart = Math.max(0, maxTime - windowSec);
  const starts: number[] = [];
  for (let t = 0; t <= maxStart + 1e-9; t += stepSec) {
    starts.push(roundTo(t, 6));
  }
  if (starts.length === 0) {
    starts.push(0);
  }

  const last = starts[starts.length - 1];
  if (Math.abs(last - maxStart) > 1e-6) {
    starts.push(roundTo(maxStart, 6));
  }
  return starts;
}

/** Normalized autocorrelation of an onset-density series over candidate lags. */
function onsetRegularity(density: number[]): number {
  const n = density.length;
  let best = 0;
  const maxLag = Math.floor(n / 2);
  for (let lag = 1; lag <= maxLag; lag++) {
    let num = 0;
    let denA = 0;
    let denB = 0;
    for (let i = 0; i < n - lag; i++) {
      num += density[i] * density[i + lag];
      denA += density[i] * density[i];
      denB += density[i + lag] * density[i + lag];
    }
    if (denA > 0 && denB > 0) {
      const r = num / Math.sqrt(denA * denB);
      if (r > best) best = r;
    }
  }
  return best;
}

/** How a window is summarized. A setting missing from a saved model takes the value that matches how models were built before it was added. */
export interface WindowFeatureOptions {
  registerDivide: number;
  chordIoiFeatures: boolean;
  /** 0 for no center features. */
  centerWindowSec: number;
}

export function windowFeatureOptions(
  config: Pick<TrainConfig, 'registerDivide' | 'chordIoiFeatures' | 'centerWindowSec'>
): WindowFeatureOptions {
  return {
    registerDivide: config.registerDivide ?? 60,
    chordIoiFeatures: config.chordIoiFeatures ?? false,
    centerWindowSec: config.centerWindowSec ?? 0
  };
}

export function extractWindowFeatures(
  notes: NoteEvent[],
  windowStart: number,
  windowSec: number,
  noteCursorHint: number,
  options: WindowFeatureOptions
): { features: number[]; nextCursorHint: number } {
  const { registerDivide, chordIoiFeatures, centerWindowSec } = options;
  const windowEnd = windowStart + windowSec;
  const lowPitchClassDurations = new Array<number>(CHROMA_SIZE).fill(0);
  const highPitchClassDurations = new Array<number>(CHROMA_SIZE).fill(0);

  const polyBins = Math.max(1, Math.ceil(windowSec / POLYPHONY_BIN_SEC));
  const binActiveDur = new Array<number>(polyBins).fill(0);
  const binHasNote = new Array<boolean>(polyBins).fill(false);

  const chordBins = 7;
  const chordBinSec = windowSec / chordBins;
  const chordPitchClasses = Array.from({ length: chordBins }, () => new Set<number>());
  const ioiCounts = new Array<number>(10).fill(0);

  const regBins = Math.max(1, Math.ceil(windowSec / REGULARITY_BIN_SEC));
  const regDensity = new Array<number>(regBins).fill(0);

  let cursor = noteCursorHint;
  while (cursor < notes.length && notes[cursor].endSec <= windowStart) {
    cursor++;
  }

  let onsetCount = 0;
  let onsetPitchSum = 0;
  let onsetPitchSqSum = 0;
  let onsetVelocitySum = 0;
  let onsetVelocitySqSum = 0;
  let onsetDurationSum = 0;
  let onsetDurationSqSum = 0;
  let activeDuration = 0;
  let minPitch = 127;
  let maxPitch = 0;
  let previousOnsetSec = -1;

  for (let i = cursor; i < notes.length; i++) {
    const note = notes[i];
    if (note.startSec >= windowEnd) break;

    const overlapStart = Math.max(note.startSec, windowStart);
    const overlapEnd = Math.min(note.endSec, windowEnd);
    const overlap = overlapEnd - overlapStart;
    if (overlap > 0) {
      const pitchClass = note.pitch % CHROMA_SIZE;
      const keyEnd = note.keyEndSec ?? note.endSec;
      const keyOverlapEnd = Math.min(keyEnd, overlapEnd);
      const keyOverlap = Math.max(0, keyOverlapEnd - overlapStart);
      const tailOverlap = overlap - keyOverlap;

      const baseVelWeight = Math.sqrt(note.velocity / 127);
      // Key-press portion receives full velocity weight; sustained ringing tail decays by 0.5x
      const weightedOverlap = (keyOverlap * baseVelWeight) + (tailOverlap * baseVelWeight * 0.5);

      if (note.pitch < registerDivide) {
        lowPitchClassDurations[pitchClass] += weightedOverlap;
      } else {
        highPitchClassDurations[pitchClass] += weightedOverlap;
      }
      activeDuration += overlap;

      const bStart = Math.max(0, Math.floor((overlapStart - windowStart) / POLYPHONY_BIN_SEC));
      const bEnd = Math.min(
        polyBins - 1,
        Math.floor((overlapEnd - windowStart - 1e-9) / POLYPHONY_BIN_SEC)
      );
      for (let b = bStart; b <= bEnd; b++) {
        const bSec = windowStart + b * POLYPHONY_BIN_SEC;
        const ovStart = Math.max(overlapStart, bSec);
        const ovEnd = Math.min(overlapEnd, bSec + POLYPHONY_BIN_SEC);
        const ov = Math.max(0, ovEnd - ovStart);
        binActiveDur[b] += ov;
        if (ov > 0) binHasNote[b] = true;
      }

      if (chordIoiFeatures) {
        const chordStart = Math.max(0, Math.floor((overlapStart - windowStart) / chordBinSec));
        const chordEnd = Math.min(
          chordBins - 1,
          Math.floor((overlapEnd - windowStart - 1e-9) / chordBinSec)
        );
        for (let b = chordStart; b <= chordEnd; b++) {
          chordPitchClasses[b].add(pitchClass);
        }
      }
    }

    if (note.startSec >= windowStart && note.startSec < windowEnd) {
      if (chordIoiFeatures && previousOnsetSec >= 0) {
        const gap = note.startSec - previousOnsetSec;
        const ioiBin = gap < 0.08 ? 0
          : gap < 0.15 ? 1
            : gap < 0.25 ? 2
              : gap < 0.4 ? 3
                : gap < 0.65 ? 4
                  : gap < 1 ? 5
                    : gap < 1.5 ? 6
                      : gap < 2.5 ? 7
                        : gap < 4 ? 8 : 9;
        ioiCounts[ioiBin]++;
      }
      previousOnsetSec = note.startSec;
      onsetCount++;
      onsetPitchSum += note.pitch;
      onsetPitchSqSum += note.pitch * note.pitch;
      onsetVelocitySum += note.velocity;
      onsetVelocitySqSum += note.velocity * note.velocity;
      const duration = note.endSec - note.startSec;
      onsetDurationSum += duration;
      onsetDurationSqSum += duration * duration;
      if (note.pitch < minPitch) minPitch = note.pitch;
      if (note.pitch > maxPitch) maxPitch = note.pitch;
      const regIdx = Math.min(
        regBins - 1,
        Math.floor((note.startSec - windowStart) / REGULARITY_BIN_SEC)
      );
      regDensity[regIdx]++;
    }
  }

  const lowTotal = lowPitchClassDurations.reduce((sum, v) => sum + v, 0);
  const highTotal = highPitchClassDurations.reduce((sum, v) => sum + v, 0);
  const normalizedLow = lowTotal > 0
    ? lowPitchClassDurations.map((value) => value / lowTotal)
    : lowPitchClassDurations;
  const normalizedHigh = highTotal > 0
    ? highPitchClassDurations.map((value) => value / highTotal)
    : highPitchClassDurations;
  const registerTotal = lowTotal + highTotal;
  const lowRegisterRatio = registerTotal > 0 ? lowTotal / registerTotal : 0;

  const meanPitch = onsetCount > 0 ? (onsetPitchSum / onsetCount) / 127 : 0;
  const pitchVariance = onsetCount > 0
    ? (onsetPitchSqSum / onsetCount) - ((onsetPitchSum / onsetCount) ** 2)
    : 0;
  const pitchStd = Math.sqrt(Math.max(0, pitchVariance)) / 127;

  const meanVelocity = onsetCount > 0 ? (onsetVelocitySum / onsetCount) / 127 : 0;
  const velocityVariance = onsetCount > 0
    ? (onsetVelocitySqSum / onsetCount) - ((onsetVelocitySum / onsetCount) ** 2)
    : 0;
  const velocityStd = Math.sqrt(Math.max(0, velocityVariance)) / 127;

  const meanDuration = onsetCount > 0 ? clamp((onsetDurationSum / onsetCount) / 6, 0, 1) : 0;
  const durationVariance = onsetCount > 0
    ? (onsetDurationSqSum / onsetCount) - ((onsetDurationSum / onsetCount) ** 2)
    : 0;
  const durationStd = clamp(Math.sqrt(Math.max(0, durationVariance)) / 6, 0, 1);

  const onsetDensity = clamp((onsetCount / windowSec) / 8, 0, 1);
  const meanPolyphony = clamp((activeDuration / windowSec) / 6, 0, 1);

  let polyphonyMean = 0;
  for (const value of binActiveDur) polyphonyMean += value / POLYPHONY_BIN_SEC;
  polyphonyMean /= polyBins;
  let polyphonyVariance = 0;
  for (const value of binActiveDur) {
    const p = value / POLYPHONY_BIN_SEC;
    polyphonyVariance += (p - polyphonyMean) ** 2;
  }
  polyphonyVariance /= polyBins;
  const polyphonyStd = clamp(Math.sqrt(Math.max(0, polyphonyVariance)) / 6, 0, 1);

  let hasNoteBins = 0;
  for (const hasNote of binHasNote) if (hasNote) hasNoteBins++;
  const silenceRatio = 1 - hasNoteBins / polyBins;

  const pitchSpan = onsetCount > 0 ? (maxPitch - minPitch) / 127 : 0;

  const regularity = onsetRegularity(regDensity);

  const features = [
    ...normalizedLow,
    ...normalizedHigh,
    lowRegisterRatio,
    onsetDensity,
    meanPitch,
    pitchStd,
    meanVelocity,
    meanDuration,
    meanPolyphony,
    velocityStd,
    durationStd,
    polyphonyStd,
    silenceRatio,
    pitchSpan,
    regularity
  ];
  if (chordIoiFeatures) {
    features.push(...chordIntervalProfile(chordPitchClasses), ...normalizeToSum(ioiCounts));
  }
  if (centerWindowSec > 0) {
    if (centerWindowSec >= windowSec) {
      throw new Error(`centerWindowSec (${centerWindowSec}) must be shorter than windowSec (${windowSec}).`);
    }
    // The center window starts later than this one, so this window's cursor
    // hint is still a valid place to start looking.
    const center = extractWindowFeatures(
      notes, windowStart + (windowSec - centerWindowSec) / 2, centerWindowSec, noteCursorHint,
      { registerDivide, chordIoiFeatures: false, centerWindowSec: 0 }
    );
    features.push(...center.features);
  }

  return { features, nextCursorHint: cursor };
}

/** Pairwise interval classes (1–6 semitones) among each bin's sounding pitch classes, normalized. */
function chordIntervalProfile(chordPitchClasses: Set<number>[]): number[] {
  const counts = new Array<number>(6).fill(0);
  for (const pitchClasses of chordPitchClasses) {
    const sorted = [...pitchClasses].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const d = Math.abs(sorted[i] - sorted[j]) % CHROMA_SIZE;
        const interval = Math.min(d, CHROMA_SIZE - d);
        if (interval > 0) counts[interval - 1]++;
      }
    }
  }
  return normalizeToSum(counts);
}

function normalizeToSum(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  return total > 0 ? values.map((value) => value / total) : values;
}

function getLabelAtTime(
  annotations: AnnotationInterval[],
  timeSec: number,
  annotationCursorHint: number
): { label: string; nextCursorHint: number } {
  let cursor = annotationCursorHint;
  while (cursor < annotations.length && timeSec >= annotations[cursor].endTime) {
    cursor++;
  }

  if (
    cursor < annotations.length
    && timeSec >= annotations[cursor].startTime
    && timeSec < annotations[cursor].endTime
  ) {
    return { label: annotations[cursor].songName, nextCursorHint: cursor };
  }

  return { label: NO_SONG_LABEL, nextCursorHint: cursor };
}

export function buildSamplesForFile(
  file: AnnotatedMidiFile,
  notes: NoteEvent[],
  config: Pick<TrainConfig, 'windowSec' | 'stepSec' | 'registerDivide' | 'chordIoiFeatures' | 'centerWindowSec'>
): WindowSample[] {
  const noteMax = notes.length > 0 ? notes[notes.length - 1].endSec : 0;
  const annotationMax = file.annotations.length > 0
    ? file.annotations[file.annotations.length - 1].endTime
    : 0;
  const maxTime = Math.max(noteMax, annotationMax);
  const starts = buildWindowStarts(maxTime, config.windowSec, config.stepSec);

  const windows: WindowSample[] = [];
  let noteCursorHint = 0;
  let annotationCursorHint = 0;

  for (const startTime of starts) {
    const { features, nextCursorHint } = extractWindowFeatures(
      notes,
      startTime,
      config.windowSec,
      noteCursorHint,
      windowFeatureOptions(config)
    );
    noteCursorHint = nextCursorHint;

    const center = startTime + (config.windowSec / 2);
    const labelInfo = getLabelAtTime(file.annotations, center, annotationCursorHint);
    annotationCursorHint = labelInfo.nextCursorHint;

    windows.push({
      fileId: file.fileId,
      fileName: file.filename,
      startTime,
      endTime: startTime + config.windowSec,
      label: labelInfo.label,
      features,
      fileIsComplete: file.isComplete
    });
  }

  return windows;
}


export function buildUnlabeledWindows(notes: NoteEvent[], config: Pick<TrainConfig, 'windowSec' | 'stepSec' | 'registerDivide' | 'chordIoiFeatures' | 'centerWindowSec'>): WindowSample[] {
  const noteMax = notes.length > 0 ? notes[notes.length - 1].endSec : 0;
  const starts = buildWindowStarts(noteMax, config.windowSec, config.stepSec);

  const windows: WindowSample[] = [];
  let noteCursorHint = 0;
  for (const startTime of starts) {
    const featureInfo = extractWindowFeatures(
      notes, startTime, config.windowSec, noteCursorHint,
      windowFeatureOptions(config)
    );
    noteCursorHint = featureInfo.nextCursorHint;
    windows.push({
      fileId: -1,
      fileName: '',
      startTime,
      endTime: startTime + config.windowSec,
      label: NO_SONG_LABEL,
      features: featureInfo.features,
      // Prediction input, never a training sample.
      fileIsComplete: false
    });
  }
  return windows;
}
