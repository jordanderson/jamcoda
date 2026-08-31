import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_SONG_LABEL,
  buildSamplesForFile,
  trainModelFromSamples,
  predictWindowsFromSamples,
  windowsToSegments,
  type AnnotatedMidiFile,
  type NoteEvent,
  type TrainConfig,
  type WindowSample
} from './songSegmentation';

const config: TrainConfig = {
  windowSec: 4,
  stepSec: 1,
  k: 7,
  maxNoneToSongRatio: 1.5,
  prototypeBudget: 120,
  maxNonePrototypes: 30,
  featureScaling: 'minmax',
  scoreMode: 'min',
  decoder: 'anchor',
  anchorMargin: 0.15,
  minAnchorRun: 2,
  fillTopK: -1,
  linkConfidence: 0.5
};

/** Build a synthetic annotated file from a flat list of notes. */
function makeFile(): AnnotatedMidiFile {
  return {
    fileId: 1,
    filename: 'synthetic.mid',
    midiPath: '',
    annotations: []
  };
}

function makeNotes(events: Array<[pitch: number, start: number, dur: number]>): NoteEvent[] {
  return events.map(([pitch, startSec, durSec]) => ({
    pitch,
    velocity: 80,
    startSec,
    endSec: startSec + durSec
  }));
}

describe('feature extraction', () => {
  it('produces 25 features including tempo and regularity', () => {
    const file = makeFile();
    // 12 pitch-class + 13 texture/rhythm features = 25
    const notes = makeNotes(Array.from({ length: 40 }, (_, i) => [60 + (i % 5) * 2, i * 0.1, 0.08]));
    const samples = buildSamplesForFile(file, notes, { windowSec: 4, stepSec: 1 });
    assert.ok(samples.length > 0);
    assert.equal(samples[0].features.length, 25);
  });

  it('registers a faster tempo for denser onsets', () => {
    const file = makeFile();
    const fastNotes = makeNotes(Array.from({ length: 80 }, (_, i) => [64, i * 0.05, 0.04]));
    const slowNotes = makeNotes(Array.from({ length: 10 }, (_, i) => [64, i * 0.4, 0.3]));
    const fastSample = buildSamplesForFile(file, fastNotes, { windowSec: 4, stepSec: 1 })[0];
    const slowSample = buildSamplesForFile(file, slowNotes, { windowSec: 4, stepSec: 1 })[0];
    const tempoIndex = 23; // tempo_bpm is the 24th feature (0-indexed 23)
    assert.ok(fastSample.features[tempoIndex] > slowSample.features[tempoIndex]);
  });
});

describe('prototype model training', () => {
  it('builds a version-2 prototype model', () => {
    const samples: WindowSample[] = [];
    for (let i = 0; i < 60; i++) {
      samples.push({
        fileId: i < 30 ? 1 : 2,
        fileName: '',
        startTime: i,
        endTime: i + 4,
        label: i < 30 ? 'Song A' : NO_SONG_LABEL,
        features: i < 30
          ? [0.8, 0.2, ...new Array(23).fill(0.1)]
          : [0, ...new Array(24).fill(0)]
      });
    }
    const model = trainModelFromSamples(samples, config);
    assert.equal(model.version, 2);
    assert.ok(model.prototypes && model.prototypes.length > 0);
    assert.ok(model.kernelScale && model.kernelScale > 0);
    assert.equal(model.featureMeans.length, 25);
    assert.ok(model.prototypeCounts!.every((c) => c > 0));
  });
});

describe('anchor-link decoder', () => {
  function makeModelForDecoding(): ReturnType<typeof trainModelFromSamples> {
    // Two song labels with distinct feature clusters plus silence windows.
    const samples: WindowSample[] = [];
    const push = (fileId: number, label: string, feats: number[], count: number) => {
      for (let i = 0; i < count; i++) {
        samples.push({ fileId, fileName: '', startTime: i, endTime: i + 4, label, features: feats });
      }
    };
    const songA = [0.7, 0.1, ...new Array(23).fill(0.15)];
    const songB = [0.1, 0.7, ...new Array(23).fill(0.15)];
    const none = [0, ...new Array(24).fill(0)];
    push(1, 'Song A', songA, 40);
    push(1, NO_SONG_LABEL, none, 40);
    push(1, 'Song B', songB, 40);
    return trainModelFromSamples(samples, config);
  }

  it('links a contiguous run through low-confidence windows and stops at silence', () => {
    const model = makeModelForDecoding();
    const songA = [0.7, 0.1, ...new Array(23).fill(0.15)];
    const none = [0, ...new Array(24).fill(0)];
    const windows = [
      ...Array.from({ length: 10 }, (_, i) => ({ startTime: i, endTime: i + 4, features: none })),
      ...Array.from({ length: 5 }, (_, i) => ({ startTime: 10 + i, endTime: 14 + i, features: songA })),
      // ambiguous gap that should be linked back to Song A
      ...Array.from({ length: 5 }, (_, i) => ({ startTime: 15 + i, endTime: 19 + i, features: [0.5, 0.3, ...new Array(23).fill(0.15)] })),
      ...Array.from({ length: 5 }, (_, i) => ({ startTime: 20 + i, endTime: 24 + i, features: songA })),
      ...Array.from({ length: 10 }, (_, i) => ({ startTime: 25 + i, endTime: 29 + i, features: none }))
    ];
    const predicted = predictWindowsFromSamples(model, windows, { minWindowConfidence: 0.45, smoothingWindows: 5 });
    const labelsInSong = predicted.filter((p) => p.startTime >= 10 && p.startTime < 25).map((p) => p.label);
    // The anchored Song A span (including the linked gap) must be labelled Song A.
    assert.ok(labelsInSong.length > 0);
    assert.ok(labelsInSong.every((label) => label === 'Song A'));
    // Silence after the song must not be linked into the song.
    const tail = predicted.filter((p) => p.startTime >= 25);
    assert.ok(tail.length > 0);
    assert.ok(tail.every((p) => p.label === NO_SONG_LABEL));
  });
});

describe('windowsToSegments', () => {
  it('merges adjacent same-song segments within the merge gap', () => {
    const windows = [
      { startTime: 0, endTime: 4, label: 'Song A', confidence: 0.5 },
      { startTime: 4, endTime: 8, label: 'Song A', confidence: 0.5 },
      { startTime: 9, endTime: 13, label: 'Song A', confidence: 0.5 },
      { startTime: 13, endTime: 17, label: NO_SONG_LABEL, confidence: 0.9 },
      { startTime: 20, endTime: 24, label: 'Song B', confidence: 0.6 }
    ];
    const segments = windowsToSegments(windows, {
      minSegmentSec: 1,
      minSegmentConfidence: 0,
      mergeGapSec: 3
    });
    assert.equal(segments.length, 2);
    assert.equal(segments[0].songName, 'Song A');
    assert.equal(segments[0].startTime, 0);
    assert.equal(segments[0].endTime, 13);
    assert.equal(segments[1].songName, 'Song B');
  });
});