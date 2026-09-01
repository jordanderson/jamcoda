import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  NO_SONG_LABEL,
  buildSamplesForFile,
  loadModel,
  saveModel,
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
  it('produces 38 features including tempo and regularity', () => {
    const file = makeFile();
    // 24 split-register pitch-class + low_register_ratio + 13 texture/rhythm = 38
    const notes = makeNotes(Array.from({ length: 40 }, (_, i) => [60 + (i % 5) * 2, i * 0.1, 0.08]));
    const samples = buildSamplesForFile(file, notes, { windowSec: 4, stepSec: 1, registerDivide: 60 });
    assert.ok(samples.length > 0);
    assert.equal(samples[0].features.length, 38);
  });

  it('separates low and high register pitch-class profiles', () => {
    const file = makeFile();
    // pcLow_* is indices 0-11, pcHigh_* is 12-23, low_register_ratio is 24.
    const lowNotes = makeNotes(Array.from({ length: 20 }, (_, i) => [48, i * 0.2, 0.15])); // C3, below divide
    const highNotes = makeNotes(Array.from({ length: 20 }, (_, i) => [72, i * 0.2, 0.15])); // C5, above divide
    const lowSample = buildSamplesForFile(file, lowNotes, { windowSec: 4, stepSec: 1, registerDivide: 60 })[0];
    const highSample = buildSamplesForFile(file, highNotes, { windowSec: 4, stepSec: 1, registerDivide: 60 })[0];

    assert.ok(lowSample.features[0] > 0.9, 'low chroma dominated by pcLow_C');
    assert.equal(lowSample.features[12], 0, 'no high-register content');
    assert.equal(lowSample.features[24], 1, 'all content below the divide');
    assert.ok(highSample.features[12] > 0.9, 'high chroma dominated by pcHigh_C');
    assert.equal(highSample.features[0], 0, 'no low-register content');
    assert.equal(highSample.features[24], 0, 'all content above the divide');
  });

  it('registers a faster tempo for denser onsets', () => {
    const file = makeFile();
    const fastNotes = makeNotes(Array.from({ length: 80 }, (_, i) => [64, i * 0.05, 0.04]));
    const slowNotes = makeNotes(Array.from({ length: 10 }, (_, i) => [64, i * 0.4, 0.3]));
    const fastSample = buildSamplesForFile(file, fastNotes, { windowSec: 4, stepSec: 1, registerDivide: 60 })[0];
    const slowSample = buildSamplesForFile(file, slowNotes, { windowSec: 4, stepSec: 1, registerDivide: 60 })[0];
    const tempoIndex = 36; // tempo_bpm is the 37th feature (0-indexed 36)
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
          ? [0.8, 0.2, ...new Array(36).fill(0.1)]
          : [0, ...new Array(37).fill(0)]
      });
    }
    const model = trainModelFromSamples(samples, config);
    assert.equal(model.version, 2);
    assert.ok(model.prototypes && model.prototypes.length > 0);
    assert.ok(model.kernelScale && model.kernelScale > 0);
    assert.equal(model.featureMeans.length, 38);
    assert.ok(model.prototypeCounts!.every((c) => c > 0));
  });
});

describe('hand-mask augmentation', () => {
  function makeSamples(songCount: number): WindowSample[] {
    const samples: WindowSample[] = [];
    for (let i = 0; i < 40; i++) {
      samples.push({
        fileId: 1,
        fileName: '',
        startTime: i,
        endTime: i + 4,
        label: i < songCount ? 'Song A' : NO_SONG_LABEL,
        // Both registers active, so every window is eligible for masking.
        features: new Array(38).fill(0.1)
      });
    }
    return samples;
  }

  it('adds one hand-masked copy per selected song window', () => {
    const model = trainModelFromSamples(makeSamples(20), {
      ...config,
      handMaskAugmentFraction: 0.5
    });
    assert.equal(model.trainingSummary.augmentedSamples, 10);
    // 20 positive + 10 augmented + all 20 none windows (ratio 1.5 exceeds supply).
    assert.equal(model.trainingSummary.totalSamples, 50);
  });

  it('does not mask a window whose target register is already empty', () => {
    const samples = makeSamples(20).map((sample) => {
      if (sample.label === NO_SONG_LABEL) return sample;
      // Low-only window: high chroma (indices 12-23) is already zero. A
      // low-mask would blank it into a silence-shaped vector still labelled
      // as the song.
      const features = new Array(38).fill(0.1);
      for (let i = 12; i < 24; i++) features[i] = 0;
      features[0] = 0.5;
      features[24] = 1;
      return { ...sample, features };
    });
    const model = trainModelFromSamples(samples, { ...config, handMaskAugmentFraction: 0.5 });
    // 10 selected windows, every one low-only. The 5 low-masking selections
    // are skipped; the 5 high-masking selections keep the low register and pass.
    assert.equal(model.trainingSummary.augmentedSamples, 5);
  });

  it('produces zero augmented samples when disabled', () => {
    const model = trainModelFromSamples(makeSamples(20), {
      ...config,
      handMaskAugmentFraction: 0
    });
    assert.equal(model.trainingSummary.augmentedSamples, 0);
  });

  it('keeps training deterministic across runs', () => {
    const train = () => trainModelFromSamples(makeSamples(20), {
      ...config,
      handMaskAugmentFraction: 0.5
    });
    const first = train();
    const second = train();
    assert.deepEqual(first.prototypes, second.prototypes);
    assert.deepEqual(first.featureMeans, second.featureMeans);
  });
});

describe('anchor-link decoder', () => {
  function makeModelForDecoding(): ReturnType<typeof trainModelFromSamples> {
    // Two song labels with distinct feature clusters plus silence windows.
    // Hand-mask augmentation is off so the decoder is measured in isolation.
    const samples: WindowSample[] = [];
    const push = (fileId: number, label: string, feats: number[], count: number) => {
      for (let i = 0; i < count; i++) {
        samples.push({ fileId, fileName: '', startTime: i, endTime: i + 4, label, features: feats });
      }
    };
    const songA = [0.7, 0.1, ...new Array(36).fill(0.15)];
    const songB = [0.1, 0.7, ...new Array(36).fill(0.15)];
    const none = [0, ...new Array(37).fill(0)];
    push(1, 'Song A', songA, 40);
    push(1, NO_SONG_LABEL, none, 40);
    push(1, 'Song B', songB, 40);
    return trainModelFromSamples(samples, { ...config, handMaskAugmentFraction: 0 });
  }

  it('links a contiguous run through low-confidence windows and stops at silence', () => {
    const model = makeModelForDecoding();
    const songA = [0.7, 0.1, ...new Array(36).fill(0.15)];
    const none = [0, ...new Array(37).fill(0)];
    const windows = [
      ...Array.from({ length: 10 }, (_, i) => ({ startTime: i, endTime: i + 4, features: none })),
      ...Array.from({ length: 5 }, (_, i) => ({ startTime: 10 + i, endTime: 14 + i, features: songA })),
      // ambiguous gap that should be linked back to Song A
      ...Array.from({ length: 5 }, (_, i) => ({ startTime: 15 + i, endTime: 19 + i, features: [0.5, 0.3, ...new Array(36).fill(0.15)] })),
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
describe('segment boundaries', () => {
  // A window label applies at the window centre. A run of windows must
  // therefore cover the span of its centres, not the union of its full
  // extents.
  function windowsForTruth(windowSec: number, stepSec: number, totalSec: number) {
    const windows = [];
    for (let t = 0; t + windowSec <= totalSec; t += stepSec) {
      const centre = t + windowSec / 2;
      const label = centre >= 20 && centre < 40
        ? 'Song A'
        : (centre >= 40 && centre < 55 ? 'Song B' : NO_SONG_LABEL);
      windows.push({ startTime: t, endTime: t + windowSec, label, confidence: 0.9 });
    }
    return windows;
  }

  it('reproduces the annotated span from centre-labelled windows', () => {
    const segments = windowsToSegments(windowsForTruth(4, 1, 60), {
      minSegmentSec: 8,
      minSegmentConfidence: 0.3,
      mergeGapSec: 3
    });
    assert.equal(segments.length, 2);
    assert.deepEqual(
      segments.map((s) => [s.songName, s.startTime, s.endTime]),
      [['Song A', 20, 40], ['Song B', 40, 55]]
    );
  });

  it('never emits overlapping segments', () => {
    const segments = windowsToSegments(windowsForTruth(4, 1, 60), {
      minSegmentSec: 8,
      minSegmentConfidence: 0.3,
      mergeGapSec: 3
    });
    for (let i = 1; i < segments.length; i++) {
      assert.ok(
        segments[i].startTime >= segments[i - 1].endTime,
        `segment ${i} starts at ${segments[i].startTime} before ${segments[i - 1].endTime}`
      );
    }
  });

  // This test records a known defect. The duration limit applies before
  // the merge, so two short runs of one song are discarded. A merge before
  // the duration limit decreased accuracy; see ml/CHANGELOG.md.
  it('discards short same-song runs instead of merging them (known defect)', () => {
    const windows = [
      ...Array.from({ length: 5 }, (_, i) => ({ startTime: i, endTime: i + 1, label: 'Song A', confidence: 0.9 })),
      { startTime: 5, endTime: 6, label: 'Song B', confidence: 0.05 },
      ...Array.from({ length: 5 }, (_, i) => ({ startTime: 6 + i, endTime: 7 + i, label: 'Song A', confidence: 0.9 }))
    ];
    const segments = windowsToSegments(windows, {
      minSegmentSec: 8,
      minSegmentConfidence: 0.3,
      mergeGapSec: 3
    });
    assert.equal(segments.length, 0);
  });
});

describe('per-label scoring fairness', () => {
  it('reports labels that fall short of the shared prototype budget', () => {
    const samples: WindowSample[] = [];
    const push = (label: string, n: number) => {
      for (let i = 0; i < n; i++) {
        samples.push({
          fileId: 1, fileName: '', startTime: i, endTime: i + 4, label,
          features: [0.5, 0.3, ...new Array(36).fill(0.2)]
        });
      }
    };
    push('Well Annotated', 400);
    push('Barely Annotated', 5);
    const model = trainModelFromSamples(samples, { ...config, prototypeBudget: 400, handMaskAugmentFraction: 0 });
    assert.deepEqual(model.trainingSummary.underAnnotatedLabels, ['Barely Annotated']);
  });

  // This test records a known defect. It does not approve of it. Three
  // corrections failed; see ml/CHANGELOG.md. The test pins the current
  // behaviour, so a future correction has a baseline to change.
  it('selects a label with more training windows too often (known defect)', () => {
    // Both songs use one distribution, so a correct scorer selects each song
    // equally often.
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const base = [0.5, 0.3, 0.2, ...new Array(35).fill(0.25)];
    const jitter = () => base.map((v) => v + (rnd() - 0.5) * 0.2);

    const samples: WindowSample[] = [];
    const push = (label: string, n: number) => {
      for (let i = 0; i < n; i++) {
        samples.push({ fileId: 1, fileName: '', startTime: i, endTime: i + 4, label, features: jitter() });
      }
    };
    push('Song Frequent', 400);
    push('Song Rare', 25);

    const model = trainModelFromSamples(samples, { ...config, handMaskAugmentFraction: 0 });
    const counts = model.labels.map((_, i) => model.prototypeCounts![i]);
    assert.ok(new Set(counts).size > 1, 'this fixture should produce unequal prototype counts');

    const norm = (v: number[]) => v.map((x, i) => (x - model.featureMeans[i]) / model.featureStds[i]);
    const d2 = (a: number[], b: number[]) => a.reduce((s, x, i) => s + ((x - b[i]) ** 2), 0);
    let frequentWins = 0;
    const trials = 400;
    for (let q = 0; q < trials; q++) {
      const v = norm(jitter());
      const nb = model.scoreNeighbors ?? 1;
      const heaps: number[][] = model.labels.map(() => []);
      for (const p of model.prototypes!) {
        const d = d2(v, p.features);
        const h = heaps[p.labelIndex];
        if (h.length < nb) { h.push(d); h.sort((x, y) => x - y); }
        else if (d < h[h.length - 1]) { h[h.length - 1] = d; h.sort((x, y) => x - y); }
      }
      const scores = heaps.map((h) => (
        h.length === 0 ? -Infinity : -(h.reduce((s: number, d: number) => s + Math.sqrt(d), 0) / h.length)
      ));
      let arg = 0;
      for (let i = 1; i < scores.length; i++) if (scores[i] > scores[arg]) arg = i;
      if (model.labels[arg] === 'Song Frequent') frequentWins++;
    }
    const share = frequentWins / trials;
    // A correct scorer gives approximately 0.5. This scorer gives more, because
    // a nearest-prototype distance decreases as a label gains prototypes.
    assert.ok(share > 0.65, `expected the known bias toward the frequent label, got ${(share * 100).toFixed(1)}%`);
  });
});

describe('anchor confidence scale', () => {
  // This test records a known defect. An anchor window keeps a raw margin
  // of 0.15 to 0.3. A linked window gets 0.5. `minSegmentConfidence` can
  // therefore discard the segment with the better evidence. One shared scale
  // decreased accuracy; see ml/CHANGELOG.md.
  it('discards an anchor run that a linked run survives (known defect)', () => {
    const mk = (n: number, confidence: number, t0: number) => Array.from({ length: n }, (_, i) => ({
      startTime: t0 + i, endTime: t0 + i + 1, label: 'Song A', confidence
    }));
    const opts = { minSegmentSec: 8, minSegmentConfidence: 0.3, mergeGapSec: 3 };

    const pureAnchors = windowsToSegments(mk(20, 0.2, 0), opts);
    const anchorsPlusFiller = windowsToSegments([...mk(3, 0.2, 0), ...mk(17, 0.5, 3)], opts);

    assert.equal(pureAnchors.length, 0, 'the confidence limit discards the anchor run');
    assert.equal(anchorsPlusFiller.length, 1, 'the linked run passes the same limit');
  });
});

describe('loadModel', () => {
  it('rejects a model trained against a different feature set', () => {
    // An 18-feature model loaded without an error before. It then returned
    // __none__ for every window, because a 38-feature vector normalized
    // against 18 constants gives NaN, and every NaN comparison is false.
    const stalePath = path.join(mkdtempSync(path.join(tmpdir(), 'jamcoda-model-')), 'stale.json');
    writeFileSync(stalePath, JSON.stringify({
      modelType: 'knn-song-segmenter',
      version: 1,
      createdAt: new Date().toISOString(),
      config: { windowSec: 4, stepSec: 1, k: 7, maxNoneToSongRatio: 1.5 },
      featureNames: new Array(18).fill('f'),
      labels: [NO_SONG_LABEL, 'Bethena'],
      featureMeans: new Array(18).fill(0),
      featureStds: new Array(18).fill(1),
      trainingVectors: [new Array(18).fill(0), new Array(18).fill(0.5)],
      trainingLabelIndices: [0, 1],
      trainingSummary: {
        filesUsed: 2, annotationsUsed: 2, totalSamples: 2,
        positiveSamples: 1, noneSamples: 1, labelCounts: {}
      }
    }));

    assert.throws(() => loadModel(stalePath), /different feature set/);
  });

  it('round-trips a freshly fitted model', () => {
    const samples: WindowSample[] = Array.from({ length: 40 }, (_, i) => ({
      fileId: 1, fileName: '', startTime: i, endTime: i + 4,
      label: i < 20 ? 'Song A' : NO_SONG_LABEL,
      features: i < 20 ? [0.8, 0.2, ...new Array(36).fill(0.1)] : [0, ...new Array(37).fill(0)]
    }));
    const modelPath = path.join(mkdtempSync(path.join(tmpdir(), 'jamcoda-model-')), 'model.json');
    saveModel(trainModelFromSamples(samples, config), modelPath);

    const loaded = loadModel(modelPath);
    assert.equal(loaded.featureNames.length, 38);
    // The model stores the resolved config, so a change to a default does
    // not change the behaviour of this model.
    assert.equal(loaded.config.decoder, 'anchor');
    assert.equal(loaded.config.scoreMode, 'min');
    assert.equal(loaded.config.featureScaling, 'minmax');
    assert.equal(loaded.config.registerDivide, 60);
  });
});
