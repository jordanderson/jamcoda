import assert from 'node:assert/strict';
import { afterAll as after, beforeAll as before, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeMidi, type MidiData, type MidiEvent } from 'midi-file';

const tempDir = mkdtempSync(join(tmpdir(), 'jamcoda-prediction-preview-'));
process.env.JAMCODA_DB_PATH = join(tempDir, 'jamcoda.db');

import * as AnnotationModel from '../models/Annotation';
import * as FileModel from '../models/File';
import * as PredictionReviewModel from '../models/PredictionReview';
import { PredictionImportError, runPredictionImport } from './predictionImport';
import { saveModel, trainModel } from '../../ml/songSegmentation';

const TICKS_PER_BEAT = 480;
const TICKS_PER_SECOND = TICKS_PER_BEAT * 2; // 120bpm

/** A run of quarter notes on one pitch, so the two songs look different. */
function phrase(startSec: number, endSec: number, pitch: number): MidiEvent[] {
  const events: MidiEvent[] = [];
  for (let t = startSec; t < endSec; t += 0.5) {
    events.push({ deltaTime: Math.round(t * TICKS_PER_SECOND), type: 'noteOn', channel: 0, noteNumber: pitch, velocity: 90 } as MidiEvent);
    events.push({ deltaTime: Math.round((t + 0.4) * TICKS_PER_SECOND), type: 'noteOff', channel: 0, noteNumber: pitch, velocity: 0 } as MidiEvent);
  }
  return events;
}

function buildMidi(): Uint8Array {
  // Low, high, then low again. Only the first stretch is annotated in the
  // database, so the pipeline has unannotated time left to predict into —
  // predictions never overlap an existing annotation.
  const absolute = [...phrase(0, 60, 60), ...phrase(60, 120, 84), ...phrase(120, 180, 60)]
    .sort((a, b) => a.deltaTime - b.deltaTime);
  let previous = 0;
  const track: MidiEvent[] = absolute.map((event) => {
    const delta = event.deltaTime - previous;
    previous = event.deltaTime;
    return { ...event, deltaTime: delta };
  });
  track.push({ deltaTime: 0, type: 'endOfTrack', meta: true } as MidiEvent);
  const data: MidiData = {
    header: { format: 0, numTracks: 1, ticksPerBeat: TICKS_PER_BEAT },
    tracks: [track]
  };
  return new Uint8Array(writeMidi(data));
}

let closeDatabase: () => void;
let fileId: number;
const midiPath = join(tempDir, 'take.mid');
const modelPath = join(tempDir, 'model.json');

before(async () => {
  const databaseModule = await import('../config/database');
  closeDatabase = databaseModule.closeDatabase;
  databaseModule.initializeDatabase();

  writeFileSync(midiPath, buildMidi());
  fileId = FileModel.create({
    jamcorderPath: '/device/take.mid',
    localPath: 'take.mid',
    filename: 'take.mid',
    fileSize: 1,
    jamcorderModified: 0,
    dateRecorded: '2026-09-06',
    midiDuration: 180
  });
  AnnotationModel.create({ fileId, songName: 'Low Song', startTime: 0, endTime: 60 });

  const { model } = trainModel(
    [{
      fileId,
      filename: 'take.mid',
      midiPath,
      isComplete: true,
      // The model still learns both songs; the database is what decides which
      // spans a prediction is allowed to cover.
      annotations: [
        { songName: 'Low Song', startTime: 0, endTime: 60 },
        { songName: 'High Song', startTime: 60, endTime: 120 },
        { songName: 'Low Song', startTime: 120, endTime: 180 }
      ]
    }],
    { windowSec: 6, stepSec: 1, k: 1, maxNoneToSongRatio: 1.5 }
  );
  saveModel(model, modelPath);
});

after(() => {
  closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.JAMCODA_DB_PATH;
});

const run = (overrides: Partial<Parameters<typeof runPredictionImport>[0]> = {}) =>
  runPredictionImport({
    fileId,
    modelPath,
    config: {
      minWindowConfidence: 0.45, smoothingWindows: 5,
      minSegmentSec: 8, minSegmentConfidence: 0.3, mergeGapSec: 5
    },
    ...overrides
  });

test('a dry run writes nothing and returns the segments it would have written', () => {
  const before = PredictionReviewModel.list({ fileId }).length;
  const preview = run({ dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.insertedCount, 0);
  assert.equal(preview.clearedCount, 0);
  assert.ok(preview.segments.length > 0, 'preview should produce segments to compare');
  assert.equal(PredictionReviewModel.list({ fileId }).length, before);
});

test('a completed file refuses a committed run but allows a preview', () => {
  FileModel.setCompletion(fileId, true);
  try {
    assert.throws(() => run({ dryRun: false }), (error: unknown) => {
      assert.ok(error instanceof PredictionImportError);
      assert.match(error.message, /marked complete/);
      return true;
    });
    // A completed file is the only place a prediction can be held against a
    // known answer, and a preview writes nothing, so it is allowed.
    const preview = run({ dryRun: true });
    assert.ok(preview.segments.length > 0);
    assert.equal(PredictionReviewModel.list({ fileId }).length, 0);
  } finally {
    FileModel.setCompletion(fileId, false);
  }
});

test('decoder overrides change the decode and are reported back', () => {
  const base = run({ dryRun: true });
  // The fixture model is trained with the current default, and the preview
  // reports the policy it actually decoded with rather than leaving it blank.
  assert.equal(base.decodeConfig.linkPolicy, 'bridge');

  const legacy = run({ dryRun: true, decoderOverrides: { linkPolicy: 'legacy' } });
  assert.equal(legacy.decodeConfig.linkPolicy, 'legacy');

  const bridged = run({ dryRun: true, decoderOverrides: { linkPolicy: 'bridge', linkTailSec: 4 } });
  assert.equal(bridged.decodeConfig.linkPolicy, 'bridge');
  assert.equal(bridged.decodeConfig.linkTailSec, 4);
  // The trained model is untouched, so the two runs stay comparable.
  assert.deepEqual(bridged.modelConfig, base.modelConfig);
  assert.equal(bridged.modelVersion, base.modelVersion);
});

test('an override of a training field is not accepted through this door', () => {
  // `decoderOverrides` is typed to decode-only keys; a caller reaching past the
  // type cannot make the segments come from a model that was never built,
  // because windowSec is read when the windows are cut, not when they decode.
  const overrides = { windowSec: 30 } as unknown as
    Parameters<typeof runPredictionImport>[0]['decoderOverrides'];
  const forced = run({ dryRun: true, decoderOverrides: overrides });
  assert.equal(forced.modelConfig.windowSec, 6, 'the model config must still describe the built model');
});
