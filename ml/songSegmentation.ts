import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseNoteSequence, buildPedalIntervals, heldByPedal } from '@core/midi/noteSequence';
import { clamp, ensureDirForFile, roundTo } from '@core/cli/args';
import { snapSegmentBoundaries, type BoundaryNote } from '@core/boundaries';
import { createNearestPrototypeScorer } from './prototypeScorer.js';

export const NO_SONG_LABEL = '__none__';

/**
 * Human-readable model release stamp, written into every fitted model.
 * Bump it whenever the features, config resolution or decoding behaviour that
 * a model captures change. `ml:eval` uses it (and the `createdAt` fallback)
 * to name its report files, so runs stay referable without manual renaming.
 * Keep `ml/CHANGELOG.md` in sync with each bump.
 */
export const MODEL_VERSION = 'v2.11';

/**
 * Version 2 features (v2.8 boundary snapping & cadence/flourish trimming, v2.7 acoustic sustain decay).
 * v2.9 z-scores them; v2.10 leaves the set unchanged and alters only training
 * data selection, the prototype budget and the decoder's link rule:
 *
 * Notes released under a held damper pedal (CC 64) ring out acoustically
 * up to 0.7s (0.6s above C5) with a 0.5x decayed tail weight, preventing false
 * collapses to silence when hands lift to shift position.
 *
 * Pitch classes are split by register (low/high at registerDivide) and
 * weighted by sqrt(velocity / 127) to emphasize intentional melodic voices
 * over pedal resonance and mechanical noise. Each register's profile is
 * normalized independently to sum 1.
 * low_register_ratio preserves the low/high energy balance.
 *
 * Texture and spread features:
 *   velocity_std / duration_std / polyphony_std   articulation and texture spread
 *   silence_ratio                                 how much of the window is dead air
 *   pitch_span                                    register width of the phrase
 *   regularity                                    peak autocorrelation of onset
 *                                                 density (rhythmic pulse strength)
 *
 * (tempo_bpm was ablated in v2.6: practice sessions have variable tempo
 * between slow practice and full speed, which added false-negative noise).
 *
 * `loadModel` rejects a model whose own `featureNames` disagree with this
 * list, so it is part of the saved model's contract and is exported for
 * callers that build or check one.
 */
export const FEATURE_NAMES = [
  'pcLow_C', 'pcLow_C#', 'pcLow_D', 'pcLow_D#', 'pcLow_E', 'pcLow_F',
  'pcLow_F#', 'pcLow_G', 'pcLow_G#', 'pcLow_A', 'pcLow_A#', 'pcLow_B',
  'pcHigh_C', 'pcHigh_C#', 'pcHigh_D', 'pcHigh_D#', 'pcHigh_E', 'pcHigh_F',
  'pcHigh_F#', 'pcHigh_G', 'pcHigh_G#', 'pcHigh_A', 'pcHigh_A#', 'pcHigh_B',
  'low_register_ratio',
  'onset_density',
  'mean_pitch',
  'pitch_std',
  'mean_velocity',
  'mean_duration',
  'mean_polyphony',
  'velocity_std',
  'duration_std',
  'polyphony_std',
  'silence_ratio',
  'pitch_span',
  'regularity'
] as const;

const CHROMA_SIZE = 12;
/** Index of the first low-register chroma feature (`pcLow_C`). */
const LOW_CHROMA_START = FEATURE_NAMES.indexOf('pcLow_C');
/** Index of the first high-register chroma feature (`pcHigh_C`). */
const HIGH_CHROMA_START = FEATURE_NAMES.indexOf('pcHigh_C');
/** Index of `low_register_ratio`. */
const LOW_REGISTER_RATIO_INDEX = FEATURE_NAMES.indexOf('low_register_ratio');
/** Index of `silence_ratio`, read by the decoder's link rule. */
const SILENCE_RATIO_INDEX = FEATURE_NAMES.indexOf('silence_ratio');

/** Sub-window bin used for polyphony spread and silence-ratio estimates. */
const POLYPHONY_BIN_SEC = 0.25;
/** Sub-window bin used for onset regularity (autocorrelation) estimates. */
const REGULARITY_BIN_SEC = 0.1;

export interface AnnotationInterval {
  songName: string;
  startTime: number;
  endTime: number;
}

export interface AnnotatedMidiFile {
  fileId: number;
  filename: string;
  midiPath: string;
  annotations: AnnotationInterval[];
  /**
   * The file is marked complete, so its unannotated time is deliberately
   * unlabeled rather than merely unreviewed. Evaluation needs the distinction:
   * predicted time landing in a complete file's gap is a false positive, while
   * the same prediction in an incomplete file may be material the user has not
   * reached yet. See `ml/eval.ts`.
   */
  isComplete: boolean;
}

export interface NoteEvent {
  pitch: number;
  velocity: number;
  startSec: number;
  endSec: number;
  /** Physical key release time before sustain-pedal extension. */
  keyEndSec?: number;
}

export interface WindowSample {
  fileId: number;
  fileName: string;
  startTime: number;
  endTime: number;
  label: string;
  features: number[];
  /**
   * The window's file is marked complete. Only then does a `__none__` label on
   * an unannotated window assert anything: see `noneFromCompleteFilesOnly`.
   */
  fileIsComplete: boolean;
}

export interface TrainConfig {
  windowSec: number;
  stepSec: number;
  /** Kept for v1 compatibility; v2 prediction is prototype-based. */
  k: number;
  maxNoneToSongRatio: number;
  /** Total prototype budget across all labels (default 2000). */
  prototypeBudget?: number;
  /** Hard cap on how many prototypes the __none__ class may keep (default 60). */
  maxNonePrototypes?: number;
  /** exp(-d/sigma) kernel scale; 0 means derive from training data (default 0). */
  kernelScale?: number;
  /** 'anchor' (default), 'viterbi', or 'smooth' sequential decoding. */
  decoder?: 'anchor' | 'smooth' | 'viterbi';
  /** Log-space penalty for switching label between adjacent windows (default 1.0). */
  viterbiChangePenalty?: number;
  /** Softmax temperature for per-window emission scores (default 1.0). */
  temperature?: number;
  /** Feature normalization: 'zscore' (default), 'minmax', 'none'. */
  featureScaling?: 'zscore' | 'minmax' | 'none';
  /**
   * Draw `__none__` training windows only from files marked complete
   * (**default false** — measured to help only at an undersized prototype
   * budget; see the v2.10 entry in `ml/CHANGELOG.md` before turning it on).
   *
   * The premise is sound: training labels every unannotated window of an
   * annotated file `__none__`, which is a statement the user made in a complete
   * file but an assumption in an incomplete one, where 63% of the audio has no
   * annotation yet and the review queue shows the user accepts predictions over
   * that time 85% of the time by duration.
   *
   * It measured as a clear win at `prototypeBudget` 2000 (+0.83 segment F1) and
   * as a regression at 8000 (-0.67). Most of the apparent gain was a side
   * effect: withholding ~62k windows lowers `__none__`'s `sqrt(support)` and so
   * raises every song's share of a fixed budget by ~9%, which is worth more
   * when songs are starved of prototypes than the negative class is worth. Once
   * songs have enough prototypes, what remains is the loss: `__none__` has to
   * cover everything that is not an annotated song, and the unannotated time in
   * incomplete files is a large part of that variety.
   *
   * Falls back to every `__none__` window when no file is complete, so a fresh
   * library still trains.
   */
  noneFromCompleteFilesOnly?: boolean;
  /**
   * A window whose `silence_ratio` reaches this value may not be linked into
   * an anchor run (default 0.7; 1 or more disables).
   *
   * Anchor linking fills any window whose evidence is weak, and a window of
   * dead air always has weak evidence, so one recognisable phrase could claim
   * the silence after it and then carry on into whatever followed. Silence is
   * not ambiguous evidence that the song continues; it is evidence that
   * nothing is being played.
   */
  linkMaxSilenceRatio?: number;
  /**
   * MIDI note pitch that separates the low (left-hand) register from the high
   * (right-hand) register in the split pitch-class features. Middle C is 60.
   * Default 60.
   */
  registerDivide?: number;
  /**
   * Fraction of annotated (song) windows that also get a hand-masked copy: the
   * low or high register chroma is zeroed and the window is added again under
   * the same label, so the model learns that a one-hand performance of a song
   * still belongs to that song. 0 disables (default).
   *
   * Measured to reduce leave-one-file-out accuracy at 0.15 and 0.5, and to
   * reduce per-window recognition of single-register windows too. Kept behind
   * the flag for when one-hand practice is better represented in the
   * annotations. See the v2.4 entry in ml/CHANGELOG.md.
   */
  handMaskAugmentFraction?: number;
  /** v2 per-label score aggregation: 'min' (nearest prototypes, default) or 'avg'. */
  scoreMode?: 'min' | 'avg';
  /**
   * 'min' mode: the number of nearest prototypes to average per label
   * (default 1, the single nearest). A higher value prevents one prototype
   * from deciding a label. The fit clamps this value to the smallest
   * per-label prototype count. A value above 1 did not improve accuracy.
   */
  scoreNeighbors?: number;
  /** Anchor-link decoder: minimum margin for an anchor seed window (default 0.15). */
  anchorMargin?: number;
  /** Anchor-link decoder: minimum consecutive anchor windows forming a seed run (default 3). */
  minAnchorRun?: number;
  /** Experimental competition between different-song anchors; absent preserves legacy linking. */
  anchorGapPolicy?: 'legacy' | 'midpoint' | 'evidence';
  /**
   * How ambiguous windows join an anchor run. `legacy` extends every run
   * outwards until a barrier, so the earlier song owns the dead zone after it
   * stops playing. `bridge` links ambiguous windows only when a second anchor
   * run of the same song closes the span; past the last anchor a run advances
   * only while the model itself still ranks that song first.
   *
   * `resolveTrainConfig` defaults this to `bridge`, so every model built from
   * 2026-09-07 records it. The *decoder* still reads an absent value as
   * `legacy`, which is what keeps a model saved before that date decoding the
   * way it was built.
   */
  linkPolicy?: 'legacy' | 'bridge';
  /**
   * With `linkPolicy: 'bridge'`, how many seconds an unvouched tail may run
   * past its anchor run before the song must be the model's own first choice
   * to continue. Defaults to 2; the rescue pass below, not the leash, is what
   * covers a take's own ending. Spans closed by a second anchor run of the same
   * song are never limited.
   */
  linkTailSec?: number;
  /**
   * Rescue pass: an unlabelled span may be given to a neighbouring song when
   * that song's *mean* score rank across the whole span is at most this value
   * (0 = the model's top choice throughout). Inside a take a song stays near the
   * top even where it never wins a single window; in the dead air between takes
   * it collapses down the ranking. A span with the same song on both sides is
   * skipped: that is the break between two takes of it. Negative disables the
   * pass, as with
   * `fillTopK`. Defaults to 5 under `linkPolicy: 'bridge'` — between the
   * measured p75 rank inside a take (4.0) and the p25 outside one (7.2) — and to
   * disabled otherwise, so legacy decoding is unchanged.
   */
  linkRescueRank?: number;
  /**
   * Rescue pass: seconds of lookahead used to test the mean rank, instead of
   * the whole span at once. 0 keeps the all-or-nothing span test.
   *
   * A span's mean is only a fair statement about the span when the span is one
   * thing. An unlabelled region often is not: a take whose middle the model
   * half-recognizes runs straight into the dead air after it, and averaging the
   * two together rejects both. With a lookahead the span is claimed by creeping
   * inwards from each end while the *local* mean holds, so a song keeps the
   * part of the span its evidence actually covers and abandons the rest. The
   * two ends advance in lockstep, as unvouched tails do.
   */
  linkRescueLookaheadSec?: number;
  /** Anchor-link decoder: minimum margin for a window to be linked into a run (default 0). */
  fillMinMargin?: number;
  /** Anchor-link decoder: a linked window must rank the run's label within its
   *  top-K labels (default -1, i.e. no affinity check -- aggressive linking). */
  fillTopK?: number;
  /**
   * Anchor-link decoder: the minimum confidence for a linked window
   * (default 0.5).
   *
   * Known defect: an anchor window keeps its raw margin, which is usually
   * 0.15 to 0.3. A linked window gets this higher value. `windowsToSegments`
   * then averages the confidences, so it can discard a segment of strong
   * anchors and keep a segment of mostly linked windows. One shared scale is
   * the obvious correction, but it decreased accuracy. See ml/CHANGELOG.md.
   */
  linkConfidence?: number;
}

export interface SongSegmentModel {
  modelType: 'knn-song-segmenter';
  version: 1 | 2;
  /** Human-readable release stamp, e.g. "v2.5". See `MODEL_VERSION`. */
  modelVersion?: string;
  createdAt: string;
  config: TrainConfig;
  featureNames: string[];
  labels: string[];
  featureMeans: number[];
  featureStds: number[];
  /** v1: raw standardized training vectors used by classic k-NN. */
  trainingVectors?: number[][];
  trainingLabelIndices?: number[];
  /** v2: condensed per-label prototypes with their label index. */
  prototypes?: Array<{ features: number[]; labelIndex: number }>;
  /** v2: number of prototypes kept per label (used for score normalization). */
  prototypeCounts?: number[];
  /** v2: kernel scale for exp(-d/sigma). */
  kernelScale?: number;
  /** v2: neighbours averaged per label in 'min' scoring, resolved at fit time. */
  scoreNeighbors?: number;
  trainingSummary: {
    filesUsed: number;
    annotationsUsed: number;
    totalSamples: number;
    positiveSamples: number;
    /** Hand-masked one-hand copies of song windows added during training. */
    augmentedSamples?: number;
    noneSamples: number;
    /**
     * `__none__` windows withheld because their file is not marked complete.
     * See `TrainConfig.noneFromCompleteFilesOnly`.
     */
    noneSamplesDroppedAsUntrusted?: number;
    labelCounts: Record<string, number>;
    /** The average per-label prototype budget. */
    prototypesPerLabel?: number;
    /**
     * Labels with fewer training windows than the average budget. These labels
     * get fewer prototypes, which makes them harder to match. Annotate these
     * songs more.
     */
    underAnnotatedLabels?: string[];
  };
}

export interface WindowPrediction {
  startTime: number;
  endTime: number;
  label: string;
  confidence: number;
}

export interface SongSegment {
  songName: string;
  startTime: number;
  endTime: number;
  durationSec: number;
  confidence: number;
}

export interface PredictConfig {
  /**
   * The minimum confidence for a window.
   *
   * The `anchor` decoder (the default) ignores this value. It uses evidence
   * margins instead. Applies to `viterbi` and `smooth` only. To tune the
   * `anchor` decoder, use `anchorMargin`.
   */
  minWindowConfidence: number;
  /**
   * The width of the majority-vote smoothing window.
   *
   * The `anchor` and `viterbi` decoders ignore this value because they make
   * continuous runs. Applies to `smooth` only.
   */
  smoothingWindows: number;
  minSegmentSec: number;
  minSegmentConfidence: number;
  mergeGapSec: number;
}

/** Whether `decoder` reads a given `PredictConfig` field at all. */
export function decoderIgnoredOptions(decoder: TrainConfig['decoder']): string[] {
  const resolved = decoder ?? 'anchor';
  if (resolved === 'anchor') return ['minWindowConfidence', 'smoothingWindows'];
  if (resolved === 'viterbi') return ['smoothingWindows'];
  return [];
}

export interface LeaveOneOutFold {
  fileId: number;
  filename: string;
  totalWindows: number;
  overallAccuracy: number;
  songWindows: number;
  songAccuracy: number;
}

export interface LeaveOneOutEvaluation {
  folds: LeaveOneOutFold[];
  meanOverallAccuracy: number;
  meanSongAccuracy: number;
}

interface AnnotationSqlRow {
  file_id: number;
  song_name: string;
  start_time: number;
  end_time: number;
  local_path: string;
  filename: string;
  is_complete: number;
}

function toNum(value: unknown): number {
  if (typeof value === 'number') return value;
  return Number(value);
}

/**
 * Resolve each optional setting to the value that the fit and the decoder
 * use. Defaults are applied here. A saved model records these values, so a
 * change to a default does not change the behaviour of an existing model.
 */
/**
 * Defaults for the four fields `TrainConfig` requires. Every optional field's
 * default lives in `resolveTrainConfig`. Both entry points that build a config
 * from user input — `ml/train.ts` and the `rebuild-model` route — read these,
 * so the CLI and the sidebar button cannot train different models.
 */
export const TRAIN_CONFIG_DEFAULTS = {
  windowSec: 6,
  stepSec: 1,
  k: 7,
  maxNoneToSongRatio: 1.5
} as const;

/**
 * Config fields the decoder reads but the fit never sees.
 *
 * Changing one of these re-decodes existing scores instead of retraining, so
 * two runs that differ only here are directly comparable — which is what makes
 * the eval score cache safe to reuse and what lets a prediction preview try a
 * decoder setting without rebuilding the model. One definition, because a
 * second copy that disagreed would silently serve stale scores.
 */
export const DECODE_ONLY_CONFIG_KEYS = [
  'decoder', 'viterbiChangePenalty', 'temperature', 'anchorMargin', 'minAnchorRun',
  'fillMinMargin', 'fillTopK', 'linkConfidence', 'linkMaxSilenceRatio', 'anchorGapPolicy',
  'linkPolicy', 'linkTailSec', 'linkRescueRank', 'linkRescueLookaheadSec'
] as const;

export type DecodeOnlyConfig = Partial<Pick<TrainConfig, typeof DECODE_ONLY_CONFIG_KEYS[number]>>;

/**
 * A `TrainConfig` with every optional field filled in. Anything that builds the
 * model takes this rather than the caller's partial config, so a default has
 * exactly one definition (`resolveTrainConfig`) and cannot be restated — and
 * disagreed with — at a use site.
 */
export type ResolvedTrainConfig = Required<
  Pick<
    TrainConfig,
    'prototypeBudget' | 'maxNonePrototypes' | 'featureScaling' | 'scoreMode'
    | 'scoreNeighbors' | 'decoder' | 'anchorMargin' | 'minAnchorRun'
    | 'fillMinMargin' | 'fillTopK' | 'linkConfidence' | 'temperature'
    | 'viterbiChangePenalty' | 'kernelScale' | 'registerDivide'
    | 'handMaskAugmentFraction' | 'noneFromCompleteFilesOnly'
    | 'linkMaxSilenceRatio' | 'linkPolicy'
  >
> & TrainConfig;

export function resolveTrainConfig(config: TrainConfig): ResolvedTrainConfig {
  const resolved: ResolvedTrainConfig = {
    ...config,
    prototypeBudget: config.prototypeBudget ?? 8000,
    maxNonePrototypes: config.maxNonePrototypes ?? 60,
    featureScaling: config.featureScaling ?? 'zscore',
    noneFromCompleteFilesOnly: config.noneFromCompleteFilesOnly ?? false,
    linkMaxSilenceRatio: config.linkMaxSilenceRatio ?? 0.7,
    registerDivide: config.registerDivide ?? 60,
    handMaskAugmentFraction: config.handMaskAugmentFraction ?? 0,
    scoreMode: config.scoreMode ?? 'min',
    scoreNeighbors: config.scoreNeighbors ?? 1,
    decoder: config.decoder ?? 'anchor',
    anchorMargin: config.anchorMargin ?? 0.15,
    minAnchorRun: config.minAnchorRun ?? 3,
    fillMinMargin: config.fillMinMargin ?? 0,
    fillTopK: config.fillTopK ?? -1,
    linkConfidence: config.linkConfidence ?? 0.5,
    temperature: config.temperature ?? 1,
    viterbiChangePenalty: config.viterbiChangePenalty ?? 1,
    kernelScale: config.kernelScale ?? 0,
    linkPolicy: config.linkPolicy ?? 'bridge'
  };

  // Bridge linking's thresholds are resolved only when that policy is on. What
  // they mean depends on `linkPolicy`, so writing them into a model built with
  // legacy linking would freeze values the decoder never used, and would then
  // quietly disagree with it if that model's policy were changed later.
  //
  // The default is `bridge` here, at fit time, and nowhere else: the decoder
  // still reads an *absent* policy as legacy, so a model saved before this
  // change keeps decoding exactly as it did. Only a model built from here on
  // records `bridge`, and it records it explicitly.
  if (resolved.linkPolicy === 'bridge') {
    resolved.linkTailSec = resolved.linkTailSec ?? 2;
    resolved.linkRescueRank = resolved.linkRescueRank ?? 5;
    resolved.linkRescueLookaheadSec = resolved.linkRescueLookaheadSec ?? 0;
  }

  return resolved;
}

/**
 * Read-only query against the app database.
 *
 * Previously this shelled out to the `sqlite3` CLI, an undeclared system
 * requirement that made `ml:train` fail on a fresh clone without it. The
 * server already depends on better-sqlite3, so this uses that instead.
 */
function sqliteJsonQuery<T>(dbPath: string, sql: string): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

export function loadAnnotatedMidiFiles(dbPath: string, rootDir: string): AnnotatedMidiFile[] {
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const rows = sqliteJsonQuery<AnnotationSqlRow>(
    dbPath,
    `
      SELECT
        a.file_id,
        a.song_name,
        a.start_time,
        a.end_time,
        f.local_path,
        f.filename,
        f.is_complete
      FROM annotations a
      JOIN files f ON f.id = a.file_id
      ORDER BY a.file_id ASC, a.start_time ASC
    `
  );

  const byFile = new Map<number, AnnotatedMidiFile>();

  for (const row of rows) {
    const fileId = toNum(row.file_id);
    const midiPath = path.resolve(rootDir, row.local_path);
    if (!existsSync(midiPath)) {
      continue;
    }

    if (!byFile.has(fileId)) {
      byFile.set(fileId, {
        fileId,
        filename: row.filename,
        midiPath,
        annotations: [],
        isComplete: toNum(row.is_complete) === 1
      });
    }

    byFile.get(fileId)!.annotations.push({
      songName: row.song_name,
      startTime: toNum(row.start_time),
      endTime: toNum(row.end_time)
    });
  }

  const files = [...byFile.values()];
  files.sort((a, b) => a.fileId - b.fileId);
  return files;
}

export function extractNotesFromMidi(midiPath: string): NoteEvent[] {
  const sequence = parseNoteSequence(new Uint8Array(readFileSync(midiPath)));
  const intervals = buildPedalIntervals(sequence.sustainEvents ?? []);

  // `core` yields absolute start/end times. Notes released under a held
  // damper pedal (CC 64) ring out acoustically: strings continue vibrating
  // until the pedal lifts or natural decay ends the ring (0.7s cap, 0.6s above C5).
  return sequence.notes.map((note) => {
    let endSec = note.endTime;
    const held = heldByPedal(intervals, note.endTime);
    if (held) {
      const pitchMax = note.pitch > 72 ? 0.6 : 0.7;
      const pedalRelease = held.up !== null ? held.up : note.endTime + pitchMax;
      const naturalLimit = note.endTime + pitchMax;
      endSec = Math.min(pedalRelease, naturalLimit);
    }
    return {
      pitch: note.pitch,
      velocity: note.velocity,
      startSec: note.startTime,
      endSec: Math.max(endSec, note.endTime),
      keyEndSec: note.endTime
    };
  });
}

function buildWindowStarts(maxTime: number, windowSec: number, stepSec: number): number[] {
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

function extractWindowFeatures(
  notes: NoteEvent[],
  windowStart: number,
  windowSec: number,
  noteCursorHint: number,
  registerDivide: number
): { features: number[]; nextCursorHint: number } {
  const windowEnd = windowStart + windowSec;
  const lowPitchClassDurations = new Array<number>(CHROMA_SIZE).fill(0);
  const highPitchClassDurations = new Array<number>(CHROMA_SIZE).fill(0);

  const polyBins = Math.max(1, Math.ceil(windowSec / POLYPHONY_BIN_SEC));
  const binActiveDur = new Array<number>(polyBins).fill(0);
  const binHasNote = new Array<boolean>(polyBins).fill(false);

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
    }

    if (note.startSec >= windowStart && note.startSec < windowEnd) {
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

  return {
    features: [
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
    ],
    nextCursorHint: cursor
  };
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
  config: Pick<TrainConfig, 'windowSec' | 'stepSec' | 'registerDivide'>
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
      config.registerDivide ?? 60
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

function evenlySample<T>(items: T[], targetCount: number): T[] {
  if (targetCount >= items.length) return items;
  if (targetCount <= 0) return [];

  const stride = items.length / targetCount;
  const sampled: T[] = [];
  for (let i = 0; i < targetCount; i++) {
    const idx = Math.floor(i * stride);
    sampled.push(items[idx]);
  }
  return sampled;
}

/**
 * Compute per-feature normalization constants. The vectors are `number[][]`
 * of raw features; `mode` decides what `means`/`stds` hold:
 *   'zscore'  means = mean,    stds = population std
 *   'minmax'  means = min,     stds = max - min
 *   'none'    means = 0,       stds = 1
 * In every mode `normalizeVector` computes `(x - means) / stds`, so a single
 * code path works for all three.
 */
function standardize(
  vectors: number[][],
  mode: 'zscore' | 'minmax' | 'none' = 'zscore'
): { means: number[]; stds: number[] } {
  const featureCount = vectors[0]?.length || 0;
  const means = new Array(featureCount).fill(0);
  const stds = new Array(featureCount).fill(1);

  if (mode === 'none') {
    return { means, stds };
  }

  if (mode === 'minmax') {
    const mins = new Array(featureCount).fill(Infinity);
    const maxs = new Array(featureCount).fill(-Infinity);
    for (const vector of vectors) {
      for (let i = 0; i < featureCount; i++) {
        if (vector[i] < mins[i]) mins[i] = vector[i];
        if (vector[i] > maxs[i]) maxs[i] = vector[i];
      }
    }
    for (let i = 0; i < featureCount; i++) {
      const range = maxs[i] - mins[i];
      means[i] = mins[i];
      stds[i] = Number.isFinite(range) && range > 1e-9 ? range : 1;
    }
    return { means, stds };
  }

  for (const vector of vectors) {
    for (let i = 0; i < featureCount; i++) {
      means[i] += vector[i];
    }
  }
  for (let i = 0; i < featureCount; i++) {
    means[i] /= Math.max(1, vectors.length);
  }

  for (const vector of vectors) {
    for (let i = 0; i < featureCount; i++) {
      const diff = vector[i] - means[i];
      stds[i] += diff * diff;
    }
  }
  for (let i = 0; i < featureCount; i++) {
    stds[i] = Math.sqrt(stds[i] / Math.max(1, vectors.length));
    if (!Number.isFinite(stds[i]) || stds[i] < 1e-6) {
      stds[i] = 1;
    }
  }

  return { means, stds };
}

function normalizeVector(vector: number[], means: number[], stds: number[]): number[] {
  return vector.map((value, idx) => (value - means[idx]) / stds[idx]);
}

function squaredDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

/**
 * Allocate a prototype count per label. Budgets scale with sqrt(support),
 * then normalize to `prototypeBudget`. The `__none__` class has a hard cap
 * because its window set is large and varied.
 *
 * Counts are unequal on purpose. A song with 4000 annotated windows covers
 * more material than a song with 50. Equal budgets discard that coverage:
 * segment F1 fell from 48.5% to 37.4%.
 *
 * Unequal counts also cause a bias. A nearest-prototype distance decreases
 * as a label gains prototypes, so a well-annotated song beats its rivals in
 * comparisons it should lose. The bias is real and unfixed. Read the v2.3
 * entry in ml/CHANGELOG.md before you try to correct it. Three corrections
 * failed.
 */
function allocatePrototypeBudgets(
  support: Map<number, number>,
  config: ResolvedTrainConfig,
  noneLabelIndex: number
): Map<number, number> {
  const maxTotal = Math.max(1, config.prototypeBudget);
  const maxNone = Math.max(1, config.maxNonePrototypes);

  let sumSqrt = 0;
  const sqrts = new Map<number, number>();
  for (const [labelIndex, count] of support) {
    const s = Math.sqrt(count);
    sqrts.set(labelIndex, s);
    sumSqrt += s;
  }

  const budgets = new Map<number, number>();
  for (const [labelIndex, s] of sqrts) {
    let budget = Math.max(1, Math.round(s * (maxTotal / sumSqrt)));
    if (labelIndex === noneLabelIndex) budget = Math.min(budget, maxNone);
    budgets.set(labelIndex, budget);
  }
  return budgets;
}

/**
 * Estimate the exp(-d/sigma) kernel scale from the training distribution:
 * the median distance from a sample to its nearest prototype. A deterministic
 * subsample keeps this cheap for leave-one-out folds.
 */
function estimateKernelScale(
  normalizedGroups: Map<number, number[][]>,
  prototypes: Array<{ features: number[]; labelIndex: number }>,
  sampleCount = 800
): number {
  const all: number[][] = [];
  for (const vectors of normalizedGroups.values()) all.push(...vectors);

  const samples = evenlySample(all, sampleCount);
  if (samples.length === 0) return 1;

  const nearestDistances: number[] = [];
  for (const vector of samples) {
    let best = Infinity;
    for (const prototype of prototypes) {
      const d = squaredDistance(vector, prototype.features);
      if (d < best) best = d;
    }
    nearestDistances.push(best);
  }

  nearestDistances.sort((a, b) => a - b);
  const median = nearestDistances[Math.floor(nearestDistances.length / 2)];
  return Math.max(median, 0.05);
}

function buildPrototypesFromGroups(
  normalizedGroups: Map<number, number[][]>,
  config: ResolvedTrainConfig,
  noneLabelIndex: number
): {
  prototypes: Array<{ features: number[]; labelIndex: number }>;
  prototypeCounts: number[];
  kernelScale: number;
  scoreNeighbors: number;
  perLabelBudget: number;
  underBudgetLabels: number[];
  labelCount: number;
} {
  const labelCount = normalizedGroups.size === 0 ? 0 : Math.max(...normalizedGroups.keys()) + 1;
  const support = new Map<number, number>();
  for (const [labelIndex, vectors] of normalizedGroups) support.set(labelIndex, vectors.length);

  const budgets = allocatePrototypeBudgets(support, config, noneLabelIndex);
  const songLabelCount = Math.max(1, support.size - (support.has(noneLabelIndex) ? 1 : 0));
  const perLabelBudget = Math.max(
    1,
    Math.floor(Math.max(1, config.prototypeBudget) / songLabelCount)
  );
  const prototypes: Array<{ features: number[]; labelIndex: number }> = [];
  const prototypeCounts = new Array<number>(labelCount).fill(0);

  for (const [labelIndex, vectors] of normalizedGroups) {
    const budget = Math.min(budgets.get(labelIndex)!, vectors.length);
    const sampled = evenlySample(vectors, budget);
    for (const vector of sampled) {
      prototypes.push({ features: vector, labelIndex });
    }
    prototypeCounts[labelIndex] = sampled.length;
  }

  // Score every label on the same number of neighbours. More neighbours give
  // a label an advantage, so the smallest per-label count sets the limit.
  const smallestCount = prototypeCounts.reduce(
    (min, count) => (count > 0 && count < min ? count : min),
    Number.POSITIVE_INFINITY
  );
  const requested = Math.max(1, Math.floor(config.scoreNeighbors));
  const scoreNeighbors = Number.isFinite(smallestCount)
    ? Math.max(1, Math.min(requested, smallestCount))
    : 1;

  // The kernel scale is read only by 'avg' scoring, but the field must stay
  // populated (`loadModel`/tests and saved-model shape). In 'min' mode — every
  // shipped config — estimate it on a token sample: the full 800-window sweep
  // cost ~21-28% of every leave-one-out fold for a value nothing reads. See
  // PERFORMANCE_TUNING.md item 1.
  const kernelScale = estimateKernelScale(
    normalizedGroups,
    prototypes,
    config.scoreMode === 'avg' ? 800 : 50
  );
  const underBudgetLabels: number[] = [];
  for (const [labelIndex, count] of support) {
    if (labelIndex !== noneLabelIndex && count < perLabelBudget) underBudgetLabels.push(labelIndex);
  }

  return {
    prototypes,
    prototypeCounts,
    kernelScale,
    scoreNeighbors,
    perLabelBudget,
    underBudgetLabels,
    labelCount
  };
}

/**
 * Deterministic hand-mask augmentation.
 *
 * A fraction of the annotated (song) windows is duplicated with one register
 * zeroed out: the low or high chroma block is set to 0 and
 * `low_register_ratio` is set to the extreme that matches the remaining
 * register. The copy keeps the original label, so the model learns that a
 * one-hand performance of a song still belongs to that song.
 *
 * A window whose target register already carries no content is left alone:
 * zeroing the last active register would turn a song window into a
 * silence-shaped vector still labelled as the song, which is exactly the
 * false-positive source this augmentation must avoid.
 *
 * Selection uses an even stride over the positive windows and alternates
 * which hand is masked, with no RNG, so training and leave-one-out eval stay
 * deterministic.
 */
function augmentHandMask(positive: WindowSample[], fraction: number): WindowSample[] {
  if (!(fraction > 0) || positive.length === 0) return [];

  const count = Math.round(positive.length * fraction);
  if (count === 0) return [];

  const stride = positive.length / count;
  const augmented: WindowSample[] = [];
  for (let k = 0; k < count; k++) {
    const idx = Math.min(positive.length - 1, Math.floor(k * stride));
    const sample = positive[idx];
    const maskLow = k % 2 === 0;
    const maskStart = maskLow ? LOW_CHROMA_START : HIGH_CHROMA_START;
    const keepStart = maskLow ? HIGH_CHROMA_START : LOW_CHROMA_START;
    if (!registerHasContent(sample.features, keepStart)) continue;

    const features = sample.features.slice();
    for (let i = 0; i < CHROMA_SIZE; i++) {
      features[maskStart + i] = 0;
    }
    features[LOW_REGISTER_RATIO_INDEX] = maskLow ? 0 : 1;
    augmented.push({ ...sample, features });
  }
  return augmented;
}

function registerHasContent(features: number[], chromaStart: number): boolean {
  for (let i = 0; i < CHROMA_SIZE; i++) {
    if (features[chromaStart + i] > 1e-9) return true;
  }
  return false;
}

function fitModelFromSamples(
  samples: WindowSample[],
  config: TrainConfig,
  trainingSummaryOverride?: Partial<SongSegmentModel['trainingSummary']>
): SongSegmentModel {
  if (samples.length === 0) {
    throw new Error('No training samples produced. Add annotations first.');
  }

  // Resolve once, then build from the resolved values only. The model saves
  // this same object, so reading a default off the caller's partial config
  // would let the saved config describe a model that was not built that way.
  const resolved = resolveTrainConfig(config);

  const positive = samples.filter((sample) => sample.label !== NO_SONG_LABEL);
  const allNegative = samples.filter((sample) => sample.label === NO_SONG_LABEL);
  // An unannotated window only means "no song" in a file the user marked
  // complete. See `noneFromCompleteFilesOnly`.
  const trustedNegative = resolved.noneFromCompleteFilesOnly
    ? allNegative.filter((sample) => sample.fileIsComplete)
    : allNegative;
  const negative = trustedNegative.length > 0 ? trustedNegative : allNegative;
  const augmented = augmentHandMask(positive, resolved.handMaskAugmentFraction);
  const maxNone = Math.max(1, Math.floor(positive.length * resolved.maxNoneToSongRatio));
  const keptNegative = evenlySample(negative, maxNone);
  const kept = [...positive, ...augmented, ...keptNegative];

  const labels = [...new Set(kept.map((sample) => sample.label))].sort((a, b) => {
    if (a === NO_SONG_LABEL) return -1;
    if (b === NO_SONG_LABEL) return 1;
    return a.localeCompare(b);
  });
  const labelToIndex = new Map(labels.map((label, idx) => [label, idx]));

  const rawVectors = kept.map((sample) => sample.features);
  const { means, stds } = standardize(rawVectors, resolved.featureScaling);

  const normalizedGroups = new Map<number, number[][]>();
  for (const sample of kept) {
    const labelIndex = labelToIndex.get(sample.label)!;
    let group = normalizedGroups.get(labelIndex);
    if (!group) {
      group = [];
      normalizedGroups.set(labelIndex, group);
    }
    group.push(normalizeVector(sample.features, means, stds));
  }

  const noneLabelIndex = labelToIndex.get(NO_SONG_LABEL) ?? -1;
  const {
    prototypes, prototypeCounts, kernelScale, scoreNeighbors,
    perLabelBudget, underBudgetLabels
  } = buildPrototypesFromGroups(normalizedGroups, resolved, noneLabelIndex);

  const labelCounts: Record<string, number> = {};
  for (const sample of kept) {
    labelCounts[sample.label] = (labelCounts[sample.label] || 0) + 1;
  }

  const distinctFiles = new Set(kept.map((sample) => sample.fileId));
  const model: SongSegmentModel = {
    modelType: 'knn-song-segmenter',
    version: 2,
    modelVersion: MODEL_VERSION,
    createdAt: new Date().toISOString(),
    // Save the resolved config, not the partial config from the caller. A
    // model that omits `decoder`, `scoreMode` or `featureScaling` changes
    // behaviour when a default changes.
    config: resolved,
    featureNames: [...FEATURE_NAMES],
    labels,
    featureMeans: means,
    featureStds: stds,
    prototypes,
    prototypeCounts,
    kernelScale,
    scoreNeighbors,
    trainingSummary: {
      filesUsed: distinctFiles.size,
      annotationsUsed: trainingSummaryOverride?.annotationsUsed ?? 0,
      totalSamples: kept.length,
      positiveSamples: positive.length,
      augmentedSamples: augmented.length,
      noneSamples: keptNegative.length,
      noneSamplesDroppedAsUntrusted: allNegative.length - negative.length,
      labelCounts,
      prototypesPerLabel: perLabelBudget,
      underAnnotatedLabels: underBudgetLabels
        .filter((labelIndex) => labelIndex !== noneLabelIndex)
        .map((labelIndex) => labels[labelIndex]),
      ...trainingSummaryOverride
    }
  };

  return model;
}

export function trainModelFromSamples(
  samples: WindowSample[],
  config: TrainConfig
): SongSegmentModel {
  return fitModelFromSamples(samples, config);
}

/** Classic k-NN over the raw training vectors (v1 models only). */
function computeKnnScores(normalizedVector: number[], model: SongSegmentModel): number[] {
  const vectors = model.trainingVectors!;
  const labels = model.trainingLabelIndices!;
  const total = vectors.length;
  const k = Math.max(1, Math.min(model.config.k, total));
  const distances = new Array<{ idx: number; distance: number }>(total);

  for (let i = 0; i < total; i++) {
    distances[i] = {
      idx: i,
      distance: squaredDistance(normalizedVector, vectors[i])
    };
  }
  distances.sort((a, b) => a.distance - b.distance);

  const scores = new Array<number>(model.labels.length).fill(0);
  for (let i = 0; i < k; i++) {
    const row = distances[i];
    const weight = 1 / (Math.sqrt(row.distance) + 1e-6);
    scores[labels[row.idx]] += weight;
  }
  return scores;
}

/** v2: per-label score from that label's prototypes. */
function computePrototypeScores(normalizedVector: number[], model: SongSegmentModel): number[] {
  const scores = new Array<number>(model.labels.length).fill(0);

  if (model.config.scoreMode === 'avg') {
    const count = new Array<number>(model.labels.length).fill(0);
    const kernelScale = model.kernelScale ?? 1;
    for (const prototype of model.prototypes!) {
      const d = squaredDistance(normalizedVector, prototype.features);
      scores[prototype.labelIndex] += Math.exp(-d / kernelScale);
      count[prototype.labelIndex]++;
    }
    for (let labelIndex = 0; labelIndex < model.labels.length; labelIndex++) {
      if (count[labelIndex] > 0) scores[labelIndex] /= count[labelIndex];
    }
    return scores;
  }

  // 'min' mode: score each label by the distance to its nearest prototypes.
  // The score is negative, so a higher score is a better match.
  //
  // Labels with more prototypes score better than they should. See
  // `allocatePrototypeBudgets` for the measurements.
  const neighbors = Math.max(1, model.scoreNeighbors ?? 1);
  const nearest: number[][] = Array.from({ length: model.labels.length }, () => []);

  for (const prototype of model.prototypes!) {
    const d = squaredDistance(normalizedVector, prototype.features);
    const heap = nearest[prototype.labelIndex];
    // Keep the `neighbors` smallest distances per label, largest last.
    if (heap.length < neighbors) {
      heap.push(d);
      heap.sort((a, b) => a - b);
    } else if (d < heap[heap.length - 1]) {
      heap[heap.length - 1] = d;
      heap.sort((a, b) => a - b);
    }
  }

  for (let labelIndex = 0; labelIndex < model.labels.length; labelIndex++) {
    const heap = nearest[labelIndex];
    if (heap.length === 0) {
      scores[labelIndex] = -Infinity;
      continue;
    }
    let sum = 0;
    for (const d of heap) sum += Math.sqrt(d);
    scores[labelIndex] = -(sum / heap.length);
  }
  return scores;
}

function computeLabelScores(normalizedVector: number[], model: SongSegmentModel): number[] {
  if (model.prototypes && model.prototypes.length > 0) {
    return computePrototypeScores(normalizedVector, model);
  }
  return computeKnnScores(normalizedVector, model);
}

// This file contained `predictLabelIndex`, a per-window argmax. Its
// confidence was `max(0, best) / sum(max(0, scores))`. In 'min' score mode
// every score is negative, so the sum was always 0 and the confidence was
// always 0. Its only caller, leave-one-out evaluation, now uses
// `predictWindowsFromSamples`.

function scoresToLogProbs(scores: number[], temperature: number): number[] {
  let maxScore = -Infinity;
  for (const score of scores) if (score > maxScore) maxScore = score;

  const shifted = scores.map((score) => (score - maxScore) / Math.max(1e-9, temperature));
  let sumExp = 0;
  for (const value of shifted) sumExp += Math.exp(value);
  const logZ = Math.log(Math.max(1e-9, sumExp));
  return shifted.map((value) => value - logZ);
}

/**
 * Viterbi decode over per-window log-probabilities with a single label-change
 * penalty. Enforces that songs occupy contiguous runs of windows, which is the
 * structure the annotations actually have.
 */
function decodeViterbi(emissions: number[][], changePenalty: number): number[] {
  const windowCount = emissions.length;
  if (windowCount === 0) return [];
  const labelCount = emissions[0].length;

  let dp = emissions[0].slice();
  const backPointers = new Array<Int32Array>(windowCount);
  backPointers[0] = new Int32Array(labelCount).fill(-1);

  for (let t = 1; t < windowCount; t++) {
    let top1 = -Infinity;
    let top2 = -Infinity;
    let arg1 = -1;
    let arg2 = -1;
    for (let labelIndex = 0; labelIndex < labelCount; labelIndex++) {
      const value = dp[labelIndex];
      if (value > top1) {
        top2 = top1;
        arg2 = arg1;
        top1 = value;
        arg1 = labelIndex;
      } else if (value > top2) {
        top2 = value;
        arg2 = labelIndex;
      }
    }

    const current = new Array<number>(labelCount);
    const back = new Int32Array(labelCount);
    const emission = emissions[t];
    for (let labelIndex = 0; labelIndex < labelCount; labelIndex++) {
      const stay = dp[labelIndex];
      const bestOther = (labelIndex === arg1 ? top2 : top1) - changePenalty;
      if (stay >= bestOther) {
        current[labelIndex] = emission[labelIndex] + stay;
        back[labelIndex] = labelIndex;
      } else {
        current[labelIndex] = emission[labelIndex] + bestOther;
        back[labelIndex] = labelIndex === arg1 ? arg2 : arg1;
      }
    }
    dp = current;
    backPointers[t] = back;
  }

  let bestLabel = 0;
  for (let labelIndex = 1; labelIndex < labelCount; labelIndex++) {
    if (dp[labelIndex] > dp[bestLabel]) bestLabel = labelIndex;
  }

  const path = new Array<number>(windowCount);
  path[windowCount - 1] = bestLabel;
  for (let t = windowCount - 1; t > 0; t--) {
    path[t - 1] = backPointers[t][path[t]];
  }
  return path;
}

interface WindowEvidence {
  scores: number[];
  bestLabel: number;
  /** Mode-agnostic margin: (top1 - top2) / (|top1| + |top2|) in score space. */
  margin: number;
  /** rank[label] = position of label in descending score order (0 = best). */
  rank: number[];
}

function computeEvidence(scoresList: number[][], needRank: boolean): WindowEvidence[] {
  return scoresList.map((scores) => {
    let top1 = -Infinity;
    let top2 = -Infinity;
    let bestLabel = 0;
    for (let labelIndex = 0; labelIndex < scores.length; labelIndex++) {
      const value = scores[labelIndex];
      if (value > top1) {
        top2 = top1;
        top1 = value;
        bestLabel = labelIndex;
      } else if (value > top2) {
        top2 = value;
      }
    }
    const scale = Math.abs(top1) + Math.abs(top2);
    const margin = scale > 1e-9 ? (top1 - top2) / scale : 0;

    // `rank` is read only when `fillTopK >= 0`; the default disables it.
    // Building it costs a sort per window — ~11M discarded allocations per
    // leave-one-out run. See PERFORMANCE_TUNING.md item 7.
    const rank = new Array<number>(scores.length).fill(0);
    if (needRank) {
      scores
        .map((score, labelIndex) => ({ score, labelIndex }))
        .sort((a, b) => b.score - a.score)
        .forEach((entry, position) => { rank[entry.labelIndex] = position; });
    }

    return { scores, bestLabel, margin, rank };
  });
}

/**
 * Two-pass "anchor and link" decoder.
 *
 * Pass 1 finds recognizable anchor runs: consecutive windows whose top label
 * beats the runner-up by a wide margin. These are the easy-to-recognize
 * phrases of a song. Pass 2 links those anchors by extending each run across
 * intervening windows whose evidence is weak or ambiguous: the generic
 * vamping, left-hand-only, or warm-up passages between recognizable moments.
 * Extension stops at a strong anchor of a different song (a real transition)
 * or a strong `__none__` anchor (genuine silence).
 */
function anchorLinkDecode(
  evidence: WindowEvidence[],
  config: TrainConfig,
  noneLabelIndex: number,
  /** Per-window: may this window be linked into a neighbouring anchor run? */
  linkable: boolean[]
): { labels: number[]; confidence: number[] } {
  const n = evidence.length;
  const labels = new Array<number>(n).fill(-1);
  const confidence = new Array<number>(n).fill(0);

  const anchorMargin = config.anchorMargin ?? 0.15;
  const minAnchorRun = Math.max(1, config.minAnchorRun ?? 3);
  const fillMinMargin = config.fillMinMargin ?? 0;
  const fillTopK = config.fillTopK ?? -1;
  const linkConfidence = clamp(config.linkConfidence ?? 0.5, 0, 1);
  const anchors: Array<{ start: number; end: number; label: number; fillConf: number }> = [];

  const isAnchor = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const e = evidence[i];
    if (e.bestLabel !== noneLabelIndex && e.margin >= anchorMargin) {
      isAnchor[i] = true;
    }
  }

  const canLink = (i: number, label: number): boolean => {
    // Dead air is not ambiguous evidence that the song continues.
    if (!linkable[i]) return false;
    const e = evidence[i];
    if (e.bestLabel === label) return true;
    if (e.margin >= anchorMargin) return false;
    if (e.margin < fillMinMargin) return false;
    if (fillTopK >= 0 && e.rank[label] >= fillTopK) return false;
    return true;
  };
  const canFill = (i: number, label: number) => labels[i] === -1 && canLink(i, label);

  // Pass 1: seed runs of consecutive same-label anchors. Linked windows get
  // the run margin, or `linkConfidence` if the margin is lower.
  for (let i = 0; i < n; ) {
    if (!isAnchor[i]) {
      i++;
      continue;
    }
    const label = evidence[i].bestLabel;
    let j = i;
    let marginSum = 0;
    while (j < n && isAnchor[j] && evidence[j].bestLabel === label) {
      marginSum += evidence[j].margin;
      j++;
    }
    if (j - i >= minAnchorRun) {
      const runMargin = marginSum / (j - i);
      const fillConf = Math.max(linkConfidence, runMargin * 0.85);
      anchors.push({ start: i, end: j, label, fillConf });
      for (let k = i; k < j; k++) {
        labels[k] = label;
        confidence[k] = evidence[k].margin;
      }
      if (config.linkPolicy !== 'bridge') {
        // Extend this run to the right.
        for (let k = j; k < n; k++) {
          if (labels[k] !== -1) break;
          if (!canFill(k, label)) break;
          labels[k] = label;
          confidence[k] = fillConf;
        }
        // Extend this run to the left.
        for (let k = i - 1; k >= 0; k--) {
          if (labels[k] !== -1) break;
          if (!canFill(k, label)) break;
          labels[k] = label;
          confidence[k] = fillConf;
        }
      }
    }
    i = j;
  }

  // Legacy linking treats "the evidence here is ambiguous" as "the song that
  // was playing is still playing", and nothing bounds that on the right. After
  // a take actually stops, the following warm-up and noodling is ambiguous but
  // not silent, so the finished song keeps claiming it until the next song
  // produces an anchor. Bridge linking splits the two cases the single
  // `canFill` rule conflates:
  //
  //   * an ambiguous span *between two anchor runs of the same song* is a
  //     passage inside a take. Both ends vouch for it, so link all of it.
  //   * an ambiguous span past a song's outermost anchor is unvouched. Nothing
  //     ahead confirms the song is still playing, so advance only while the
  //     model itself still ranks that song first.
  if (config.linkPolicy === 'bridge') {
    // These two fallbacks must match `resolveTrainConfig`; a model trained with
    // this policy carries both explicitly, so they only apply to a config that
    // was never resolved.
    const tailLimit = Math.floor((config.linkTailSec ?? 2) / Math.max(1e-9, config.stepSec));
    /**
     * The leash arbitrates contention between two songs. Beyond a song's
     * outermost anchor in a recording there is no other song to arbitrate
     * against, so silence stays the only stop, as it was before.
     */
    const contested = (a: number, side: 1 | -1): boolean => {
      for (let b = a + side; b >= 0 && b < anchors.length; b += side) {
        if (anchors[b].label !== anchors[a].label) return true;
      }
      return false;
    };

    const claim = (k: number, run: { label: number; fillConf: number }, limit = Infinity, distance = 0): boolean => {
      if (k < 0 || k >= n || labels[k] !== -1 || !canLink(k, run.label)) return false;
      // Past the leash the song must still be the model's own first choice.
      if (distance > limit && evidence[k].bestLabel !== run.label) return false;
      labels[k] = run.label;
      confidence[k] = run.fillConf;
      return true;
    };

    // Vouched: another anchor run of the same song closes this side, so the
    // span is a passage inside a take and links with no leash, exactly as
    // before. Extending from both ends rather than requiring the whole span to
    // be fillable keeps the legacy reach when something blocks the middle.
    for (let a = 0; a < anchors.length; a++) {
      const run = anchors[a];
      if (anchors[a + 1]?.label === run.label) {
        for (let k = run.end; claim(k, run); k++);
      }
      if (anchors[a - 1]?.label === run.label) {
        for (let k = run.start - 1; claim(k, run); k--);
      }
    }

    // Unvouched tails advance in lockstep. Two songs reaching for the same
    // window meet in the middle instead of the earlier one taking all of it,
    // which is the directional bias that made a finished song run long.
    const rightAlive = anchors.map((run, a) => anchors[a + 1]?.label !== run.label);
    const leftAlive = anchors.map((run, a) => anchors[a - 1]?.label !== run.label);
    const rightLimit = anchors.map((_, a) => (contested(a, 1) ? tailLimit : Infinity));
    const leftLimit = anchors.map((_, a) => (contested(a, -1) ? tailLimit : Infinity));
    for (let d = 1; ; d++) {
      let advanced = false;
      for (let a = 0; a < anchors.length; a++) {
        if (rightAlive[a]) {
          rightAlive[a] = claim(anchors[a].end + d - 1, anchors[a], rightLimit[a], d);
          advanced = advanced || rightAlive[a];
        }
        if (leftAlive[a]) {
          leftAlive[a] = claim(anchors[a].start - d, anchors[a], leftLimit[a], d);
          advanced = advanced || leftAlive[a];
        }
      }
      if (!advanced) break;
    }
  }

  // Legacy extension gives the earlier song first claim on every ambiguous
  // window. Compete only inside an uninterrupted, mutually linkable gap between
  // two established different-song anchors. Preserve silence, strong third-song
  // evidence, same-song links, and open recording edges.
  if (config.anchorGapPolicy && config.anchorGapPolicy !== 'legacy') {
    for (let a = 1; a < anchors.length; a++) {
      const left = anchors[a - 1];
      const right = anchors[a];
      if (left.label === right.label || left.end >= right.start) continue;
      let eligible = true;
      for (let i = left.end; i < right.start; i++) {
        if (!canLink(i, left.label) || !canLink(i, right.label)) {
          eligible = false;
          break;
        }
      }
      if (!eligible) continue;
      const midpoint = (left.end + right.start) / 2;
      let split = Math.round(midpoint);
      if (config.anchorGapPolicy === 'evidence') {
        // Maximize evidence for a single A -> B change. Moving the cut right
        // changes the objective by score(A) - score(B) at that window.
        let cumulative = 0;
        let best = 0;
        split = left.end;
        for (let i = left.end; i < right.start; i++) {
          cumulative += evidence[i].scores[left.label] - evidence[i].scores[right.label];
          if (cumulative > best || (cumulative === best
            && Math.abs(i + 1 - midpoint) < Math.abs(split - midpoint))) {
            best = cumulative;
            split = i + 1;
          }
        }
      }
      for (let i = left.end; i < right.start; i++) {
        const owner = i < split ? left : right;
        labels[i] = owner.label;
        confidence[i] = owner.fillConf;
      }
    }
  }

  // Per-window evidence cannot tell a passage the model half-recognizes from
  // the dead air after a take: in both, no song wins the window. Averaged over a
  // whole span it can. A song sits a median rank of 1.3 across spans inside its
  // own take and 16 across spans outside it, so a span-level mean recovers the
  // long takes that a leash truncates without reopening the gap between takes.
  const rescueRank = config.linkRescueRank ?? (config.linkPolicy === 'bridge' ? 5 : -1);
  if (rescueRank >= 0) {
    const rescueConfidence = clamp(config.linkConfidence ?? 0.5, 0, 1);
    // A lookahead of 0 tests the whole span at once, which is the original rule.
    const lookahead = Math.max(0, config.linkRescueLookaheadSec ?? 0);
    const reach = lookahead > 0
      ? Math.max(1, Math.round(lookahead / Math.max(1e-9, config.stepSec)))
      : 0;
    const meanRank = (from: number, to: number, label: number): number => {
      let sum = 0;
      for (let i = from; i < to; i++) {
        const scores = evidence[i].scores;
        const value = scores[label];
        for (let c = 0; c < scores.length; c++) if (scores[c] > value) sum++;
      }
      return sum / (to - from);
    };
    for (let i = 0; i < n; ) {
      if (labels[i] !== -1 || !linkable[i]) {
        i++;
        continue;
      }
      // Silence still splits a span rather than being claimed with it.
      let j = i;
      while (j < n && labels[j] === -1 && linkable[j]) j++;
      const left = i > 0 ? labels[i - 1] : -1;
      const right = j < n ? labels[j] : -1;
      let best = -1;
      let bestRank = rescueRank;
      // The rescue exists to undo the leash, and the leash only ever applies to
      // a song's outer edge. The same song on both sides was never leashed — it
      // was vouched, and something stopped the fill — so this is the break
      // between two takes of one song, not a passage inside one. Absorbing it
      // would merge the takes, which is already the largest error left.
      const betweenTakesOfOneSong = left >= 0 && left === right && left !== noneLabelIndex;
      const claimable = (label: number) => label >= 0 && label !== noneLabelIndex
        && !betweenTakesOfOneSong;

      if (reach > 0) {
        // Creep inwards from each end while that side's own lookahead holds.
        // Where both sides qualify they meet in the middle, and where neither
        // does the span stays unlabelled — the same arbitration the leash uses.
        let lo = i;
        let hi = j;
        let leftAlive = claimable(left);
        let rightAlive = claimable(right);
        while (hi > lo && (leftAlive || rightAlive)) {
          if (leftAlive) {
            leftAlive = meanRank(lo, Math.min(lo + reach, hi), left) <= rescueRank;
            if (leftAlive) {
              labels[lo] = left;
              confidence[lo] = rescueConfidence;
              lo++;
            }
          }
          if (rightAlive && hi > lo) {
            rightAlive = meanRank(Math.max(hi - reach, lo), hi, right) <= rescueRank;
            if (rightAlive) {
              labels[hi - 1] = right;
              confidence[hi - 1] = rescueConfidence;
              hi--;
            }
          }
        }
        i = j;
        continue;
      }

      for (const neighbour of [left, right]) {
        if (!claimable(neighbour) || neighbour === best) continue;
        const rank = meanRank(i, j, neighbour);
        if (rank <= bestRank) {
          bestRank = rank;
          best = neighbour;
        }
      }
      if (best >= 0) {
        for (let k = i; k < j; k++) {
          labels[k] = best;
          confidence[k] = rescueConfidence;
        }
      }
      i = j;
    }
  }

  for (let i = 0; i < n; i++) {
    if (labels[i] === -1) labels[i] = noneLabelIndex;
  }

  return { labels, confidence };
}

export function trainModel(
  files: AnnotatedMidiFile[],
  config: TrainConfig
): { model: SongSegmentModel; samplesByFile: Map<number, WindowSample[]> } {
  const samplesByFile = new Map<number, WindowSample[]>();
  const allSamples: WindowSample[] = [];
  let annotationsUsed = 0;

  for (const file of files) {
    const notes = extractNotesFromMidi(file.midiPath);
    const windows = buildSamplesForFile(file, notes, config);
    samplesByFile.set(file.fileId, windows);
    allSamples.push(...windows);
    annotationsUsed += file.annotations.length;
  }

  const model = fitModelFromSamples(allSamples, config, {
    filesUsed: files.length,
    annotationsUsed
  });

  return { model, samplesByFile };
}

export function evaluateLeaveOneOut(
  files: AnnotatedMidiFile[],
  config: TrainConfig,
  samplesByFile?: Map<number, WindowSample[]>
): LeaveOneOutEvaluation {
  const windowsByFile = samplesByFile || new Map<number, WindowSample[]>();
  if (!samplesByFile) {
    for (const file of files) {
      const notes = extractNotesFromMidi(file.midiPath);
      windowsByFile.set(file.fileId, buildSamplesForFile(file, notes, config));
    }
  }

  const folds: LeaveOneOutFold[] = [];

  for (const testFile of files) {
    const trainSamples: WindowSample[] = [];
    const testSamples = windowsByFile.get(testFile.fileId) || [];

    for (const file of files) {
      if (file.fileId === testFile.fileId) continue;
      trainSamples.push(...(windowsByFile.get(file.fileId) || []));
    }

    if (trainSamples.length === 0 || testSamples.length === 0) {
      continue;
    }

    const foldModel = fitModelFromSamples(trainSamples, config);
    let totalCorrect = 0;
    let songTotal = 0;
    let songCorrect = 0;

    // Measure the decoder that the app uses. This code used a per-window
    // argmax before. That path has no anchor seeding, no linking, and no
    // `__none__` handling, so `ml:train` and `rebuild-model` reported an
    // accuracy for a path that no caller runs, and disagreed with `ml:eval`.
    const predictions = predictWindowsFromSamples(foldModel, testSamples, {
      minWindowConfidence: 0,
      smoothingWindows: 1
    });

    for (let i = 0; i < testSamples.length; i++) {
      const sample = testSamples[i];
      const predictedLabel = predictions[i]?.label ?? NO_SONG_LABEL;

      if (predictedLabel === sample.label) {
        totalCorrect++;
      }
      if (sample.label !== NO_SONG_LABEL) {
        songTotal++;
        if (predictedLabel === sample.label) {
          songCorrect++;
        }
      }
    }

    folds.push({
      fileId: testFile.fileId,
      filename: testFile.filename,
      totalWindows: testSamples.length,
      overallAccuracy: totalCorrect / testSamples.length,
      songWindows: songTotal,
      songAccuracy: songTotal > 0 ? songCorrect / songTotal : 0
    });
  }

  if (folds.length === 0) {
    return {
      folds: [],
      meanOverallAccuracy: 0,
      meanSongAccuracy: 0
    };
  }

  const meanOverallAccuracy = folds.reduce((sum, fold) => sum + fold.overallAccuracy, 0) / folds.length;
  const meanSongAccuracy = folds.reduce((sum, fold) => sum + fold.songAccuracy, 0) / folds.length;

  return {
    folds,
    meanOverallAccuracy,
    meanSongAccuracy
  };
}

export function saveModel(model: SongSegmentModel, outPath: string) {
  ensureDirForFile(outPath);
  writeFileSync(outPath, JSON.stringify(model, null, 2), 'utf8');
}

export function loadModel(modelPath: string): SongSegmentModel {
  const raw = readFileSync(modelPath, 'utf8');
  const parsed = JSON.parse(raw) as SongSegmentModel;

  if (parsed.modelType !== 'knn-song-segmenter') {
    throw new Error(`Unsupported model type: ${String((parsed as any).modelType)}`);
  }
  const hasPrototypes = Array.isArray(parsed.prototypes) && parsed.prototypes.length > 0;
  const hasVectors = Array.isArray(parsed.trainingVectors) && parsed.trainingVectors.length > 0;
  if (!hasPrototypes && !hasVectors) {
    throw new Error('Model has no training vectors or prototypes.');
  }

// A model with a different feature set fails without an error.
    // `normalizeVector` reads past the end of `featureMeans`, so each distance
    // becomes NaN. Every comparison with NaN is false, and the decoder
    // returns `__none__` for every window. The user sees 0 segments and no
    // error. The feature vector changed from 18 to 25 entries in v2.0, so
    // check it.
  const expected = FEATURE_NAMES as readonly string[];
  const actual = Array.isArray(parsed.featureNames) ? parsed.featureNames : [];
  const mismatched = actual.length !== expected.length
    || actual.some((name, idx) => name !== expected[idx]);
  if (mismatched) {
    throw new Error(
      `Model was trained with a different feature set (${actual.length} features, `
      + `this build extracts ${expected.length}). Retrain it: `
      + 'npm run ml:train -- --out <model path>, or use "Rebuild Model" in the sidebar.'
    );
  }
  if (parsed.featureMeans?.length !== expected.length || parsed.featureStds?.length !== expected.length) {
    throw new Error('Model normalization constants do not match its feature set. Retrain the model.');
  }

  return parsed;
}

function buildUnlabeledWindows(notes: NoteEvent[], config: Pick<TrainConfig, 'windowSec' | 'stepSec' | 'registerDivide'>): WindowSample[] {
  const noteMax = notes.length > 0 ? notes[notes.length - 1].endSec : 0;
  const starts = buildWindowStarts(noteMax, config.windowSec, config.stepSec);

  const windows: WindowSample[] = [];
  let noteCursorHint = 0;
  for (const startTime of starts) {
    const featureInfo = extractWindowFeatures(notes, startTime, config.windowSec, noteCursorHint, config.registerDivide ?? 60);
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

export function predictWindows(
  model: SongSegmentModel,
  midiPath: string,
  options: PredictConfig
): WindowPrediction[] {
  const notes = extractNotesFromMidi(midiPath);
  const windows = buildUnlabeledWindows(notes, model.config);
  return predictWindowsFromSamples(model, windows, options);
}

export function predictWindowsFromSamples(
  model: SongSegmentModel,
  windows: Pick<WindowSample, 'startTime' | 'endTime' | 'features'>[],
  options: Pick<PredictConfig, 'minWindowConfidence' | 'smoothingWindows'>
): WindowPrediction[] {
  return decodeWindowScores(model, windows, scoreWindowsFromSamples(model, windows), options);
}

/** Expensive stage, independent of decoder and segment-filter settings. */
export function scoreWindowsFromSamples(
  model: SongSegmentModel,
  windows: Pick<WindowSample, 'features'>[]
): number[][] {
  const score = model.prototypes?.length && model.config.scoreMode !== 'avg'
    && Math.max(1, model.scoreNeighbors ?? 1) === 1
    ? createNearestPrototypeScorer(model.prototypes, model.labels.length)
    : (vector: number[]) => computeLabelScores(vector, model);
  return windows.map((window) => score(
    normalizeVector(window.features, model.featureMeans, model.featureStds)
  ));
}

/** Cheap stage: the scores must come from this model and these windows, in order. */
export function decodeWindowScores(
  model: Pick<SongSegmentModel, 'config' | 'labels'>,
  windows: Pick<WindowSample, 'startTime' | 'endTime' | 'features'>[],
  scoresList: number[][],
  options: Pick<PredictConfig, 'minWindowConfidence' | 'smoothingWindows'>
): WindowPrediction[] {
  const windowCount = windows.length;
  if (scoresList.length !== windowCount || scoresList.some((row) => row.length !== model.labels.length)) {
    throw new Error('Score matrix dimensions do not match the model labels and windows.');
  }
  if (windowCount === 0) return [];

  const decoder = model.config.decoder ?? 'anchor';
  const temperature = model.config.temperature ?? 1;

  if (decoder === 'anchor') {
    const noneLabelIndex = model.labels.indexOf(NO_SONG_LABEL);
    const evidence = computeEvidence(scoresList, (model.config.fillTopK ?? -1) >= 0);
    // A model saved before this rule existed has no value here, and a change
    // to a default must not change an existing model (see v2.3 in the
    // changelog), so an absent value means "off" rather than the new default.
    const maxLinkSilence = model.config.linkMaxSilenceRatio ?? Number.POSITIVE_INFINITY;
    const linkable = windows.map(
      (window) => window.features[SILENCE_RATIO_INDEX] < maxLinkSilence
    );
    const { labels, confidence } = anchorLinkDecode(
      evidence, model.config, noneLabelIndex, linkable
    );
    const predictions: WindowPrediction[] = [];
    for (let i = 0; i < windowCount; i++) {
      predictions.push({
        startTime: windows[i].startTime,
        endTime: windows[i].endTime,
        label: model.labels[labels[i]],
        confidence: confidence[i]
      });
    }
    return predictions;
  }

  const changePenalty = model.config.viterbiChangePenalty ?? 1;
  const emissions = scoresList.map((scores) => scoresToLogProbs(scores, temperature));

  let finalLabels: number[];
  let finalConfidence: number[];
  if (decoder === 'viterbi') {
    const path = decodeViterbi(emissions, changePenalty);
    finalLabels = path;
    finalConfidence = path.map((labelIndex, i) => Math.exp(emissions[i][labelIndex]));
  } else {
    finalLabels = emissions.map((emission) => {
      let best = 0;
      for (let labelIndex = 1; labelIndex < emission.length; labelIndex++) {
        if (emission[labelIndex] > emission[best]) best = labelIndex;
      }
      return best;
    });
    finalConfidence = finalLabels.map((labelIndex, i) => Math.exp(emissions[i][labelIndex]));
  }

  const predictions: WindowPrediction[] = [];
  for (let i = 0; i < windowCount; i++) {
    let label = model.labels[finalLabels[i]];
    if (finalConfidence[i] < options.minWindowConfidence) {
      label = NO_SONG_LABEL;
    }
    predictions.push({
      startTime: windows[i].startTime,
      endTime: windows[i].endTime,
      label,
      confidence: finalConfidence[i]
    });
  }

  if (decoder === 'viterbi') {
    return predictions;
  }
  return smoothWindowPredictions(predictions, options.smoothingWindows);
}

export function smoothWindowPredictions(
  windows: WindowPrediction[],
  smoothingWindows: number
): WindowPrediction[] {
  if (smoothingWindows <= 1 || windows.length <= 1) {
    return [...windows];
  }

  const radius = Math.floor(smoothingWindows / 2);
  const smoothed: WindowPrediction[] = [];

  for (let i = 0; i < windows.length; i++) {
    const start = Math.max(0, i - radius);
    const end = Math.min(windows.length - 1, i + radius);
    const voteScores = new Map<string, number>();
    let totalScore = 0;

    for (let j = start; j <= end; j++) {
      const label = windows[j].label;
      const score = windows[j].confidence;
      voteScores.set(label, (voteScores.get(label) || 0) + score);
      totalScore += score;
    }

    let bestLabel = windows[i].label;
    let bestScore = -1;
    for (const [label, score] of voteScores.entries()) {
      if (score > bestScore) {
        bestLabel = label;
        bestScore = score;
      }
    }

    smoothed.push({
      startTime: windows[i].startTime,
      endTime: windows[i].endTime,
      label: bestLabel,
      confidence: totalScore > 0 ? bestScore / totalScore : windows[i].confidence
    });
  }

  return smoothed;
}

export interface SongRangeSuggestion {
  songName: string;
  /** Share of the range's confident window evidence assigned to this song. */
  confidence: number;
}

function rangeWindowStarts(
  startTime: number,
  endTime: number,
  windowSec: number,
  stepSec: number
): number[] {
  const maxStart = endTime - windowSec;
  if (maxStart <= startTime) {
    // The range is shorter than one window: center a single window on it.
    return [roundTo(Math.max(0, (startTime + endTime) / 2 - windowSec / 2), 6)];
  }

  const starts: number[] = [];
  for (let t = startTime; t <= maxStart + 1e-9; t += stepSec) {
    starts.push(roundTo(t, 6));
  }
  const last = starts[starts.length - 1];
  if (Math.abs(last - maxStart) > 1e-6) {
    starts.push(roundTo(maxStart, 6));
  }
  return starts;
}

/**
 * Rank songs for a time range in one MIDI file, for annotate-time
 * suggestions.
 *
 * Runs the raw classifier over windows covering `[startTime, endTime]`, then
 * aggregates each window's margin (top-label evidence strength) by song. The
 * result is the share of confident evidence each song received. A segment
 * that clearly matches one song comes back with a single high-confidence
 * suggestion. Ambiguous or new material spreads the evidence thin and usually
 * falls below `minConfidence`.
 */
export function suggestSongsForRange(
  model: SongSegmentModel,
  midiPath: string,
  startTime: number,
  endTime: number,
  options: { minConfidence?: number; topK?: number } = {}
): SongRangeSuggestion[] {
  if (!(endTime > startTime)) return [];

  const notes = extractNotesFromMidi(midiPath);
  const windowSec = model.config.windowSec;
  const stepSec = model.config.stepSec;
  const starts = rangeWindowStarts(startTime, endTime, windowSec, stepSec);
  if (starts.length === 0) return [];

  const minConfidence = options.minConfidence ?? 0.3;
  const topK = options.topK ?? 4;
  const evidenceByLabel = new Array<number>(model.labels.length).fill(0);
  let totalEvidence = 0;
  let noteCursor = 0;

  for (const start of starts) {
    const featureInfo = extractWindowFeatures(
      notes,
      start,
      windowSec,
      noteCursor,
      model.config.registerDivide ?? 60
    );
    noteCursor = featureInfo.nextCursorHint;
    const normalized = normalizeVector(featureInfo.features, model.featureMeans, model.featureStds);
    const scores = computeLabelScores(normalized, model);

    let top1 = -Infinity;
    let top2 = -Infinity;
    let top1Label = 0;
    for (let labelIndex = 0; labelIndex < scores.length; labelIndex++) {
      const value = scores[labelIndex];
      if (value > top1) {
        top2 = top1;
        top1 = value;
        top1Label = labelIndex;
      } else if (value > top2) {
        top2 = value;
      }
    }
    const scale = Math.abs(top1) + Math.abs(top2);
    const margin = scale > 1e-9 ? (top1 - top2) / scale : 0;
    evidenceByLabel[top1Label] += margin;
    totalEvidence += margin;
  }

  if (totalEvidence <= 1e-9) return [];

  return model.labels
    .map((songName, labelIndex) => ({
      songName,
      confidence: evidenceByLabel[labelIndex] / totalEvidence
    }))
    .filter((suggestion) => suggestion.songName !== NO_SONG_LABEL && suggestion.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, topK);
}

/** The window step, calculated from the windows, not from the model config. */
function inferStepSec(windows: WindowPrediction[]): number {
  for (let i = 1; i < windows.length; i++) {
    const delta = windows[i].startTime - windows[i - 1].startTime;
    if (delta > 1e-9) return delta;
  }
  return Math.max(1e-9, windows[0].endTime - windows[0].startTime);
}

export function windowsToSegments(
  windows: WindowPrediction[],
  options: Pick<PredictConfig, 'minSegmentSec' | 'minSegmentConfidence' | 'mergeGapSec'>,
  notes?: NoteEvent[] | BoundaryNote[]
): SongSegment[] {
  const provisional: SongSegment[] = [];
  if (windows.length === 0) return provisional;

  // A window label describes the song at the window centre. Training uses the
  // same rule: `buildSamplesForFile` labels each window at
  // `startTime + windowSec / 2`.
  //
  // The full window extent is therefore the wrong span. It made each segment
  // half a window too long at each end, and made adjacent segments overlap by
  // `windowSec - stepSec` (3s at the 4s/1s default). These segments go into
  // `prediction_reviews` and then into annotations. Centres give the correct
  // span.
  const lastIndex = windows.length - 1;
  const stepSec = inferStepSec(windows);
  const centreOf = (i: number) => (windows[i].startTime + windows[i].endTime) / 2;
  // The first run starts at the start of the audio. The last run continues
  // to the end. Other runs continue to the centre of the next window.
  const boundStart = (i: number) => (i === 0 ? windows[0].startTime : centreOf(i));
  const boundEnd = (i: number) => (
    i === lastIndex
      ? windows[i].endTime
      : Math.min(centreOf(i) + stepSec, windows[i].endTime)
  );

  let runStartIndex = 0;
  const flush = (endIndex: number) => {
    const label = windows[runStartIndex].label;
    if (!label || label === NO_SONG_LABEL) return;

    let confidenceSum = 0;
    for (let i = runStartIndex; i <= endIndex; i++) confidenceSum += windows[i].confidence;

    const startTime = boundStart(runStartIndex);
    const endTime = boundEnd(endIndex);
    if (endTime <= startTime) return;

    provisional.push({
      songName: label,
      startTime,
      endTime,
      durationSec: endTime - startTime,
      confidence: confidenceSum / (endIndex - runStartIndex + 1)
    });
  };

  for (let i = 1; i <= lastIndex; i++) {
    if (windows[i].label === windows[runStartIndex].label) continue;
    flush(i - 1);
    runStartIndex = i;
  }
  flush(lastIndex);

  const filtered = provisional.filter(
    (segment) =>
      segment.durationSec >= options.minSegmentSec
      && segment.confidence >= options.minSegmentConfidence
  );
  const merged: SongSegment[] = [];
  for (const segment of filtered) {
    const last = merged[merged.length - 1];
    if (
      last
      && last.songName === segment.songName
      && segment.startTime - last.endTime <= options.mergeGapSec
    ) {
      const combinedDuration = (last.endTime - last.startTime) + (segment.endTime - segment.startTime);
      const weightedConfidence = (
        (last.confidence * (last.endTime - last.startTime))
        + (segment.confidence * (segment.endTime - segment.startTime))
      ) / Math.max(1e-9, combinedDuration);

      last.endTime = segment.endTime;
      last.durationSec = last.endTime - last.startTime;
      last.confidence = weightedConfidence;
    } else {
      merged.push({ ...segment });
    }
  }

  // Refine boundaries against physical note onsets and acoustic releases,
  // trimming extraneous ending flourishes (arpeggios) if notes are provided.
  let candidates = merged;
  if (notes && notes.length > 0) {
    candidates = candidates
      .map((segment) => {
        const snapped = snapSegmentBoundaries(segment.startTime, segment.endTime, notes, {
          trimFlourish: true
        });
        const startTime = roundTo(snapped.startTime);
        const endTime = roundTo(snapped.endTime);
        const durationSec = roundTo(endTime - startTime);
        return {
          ...segment,
          startTime,
          endTime,
          durationSec
        };
      })
      .filter((segment) => segment.durationSec >= options.minSegmentSec);
  }

  return candidates
    .map((segment) => ({
      ...segment,
      startTime: roundTo(segment.startTime),
      endTime: roundTo(segment.endTime),
      durationSec: roundTo(segment.durationSec),
      confidence: roundTo(segment.confidence)
    }));
}
