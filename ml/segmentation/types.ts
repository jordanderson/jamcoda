/**
 * Shared shapes and tuning constants for song segmentation.
 *
 * Kept apart from the code that uses them so config, features, model and
 * decode can all import from one place without cycles.
 */

export const NO_SONG_LABEL = '__none__';

/**
 * Human-readable model release stamp, written into every fitted model.
 * Bump it whenever the features, config resolution or decoding behaviour that
 * a model captures change. `ml:eval` uses it (and the `createdAt` fallback)
 * to name its report files, so runs stay referable without manual renaming.
 * Keep `ml/CHANGELOG.md` in sync with each bump.
 */
export const MODEL_VERSION = 'v2.12';

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

export const CHROMA_SIZE = 12;
/** Index of the first low-register chroma feature (`pcLow_C`). */
export const LOW_CHROMA_START = FEATURE_NAMES.indexOf('pcLow_C');
/** Index of the first high-register chroma feature (`pcHigh_C`). */
export const HIGH_CHROMA_START = FEATURE_NAMES.indexOf('pcHigh_C');
/** Index of `low_register_ratio`. */
export const LOW_REGISTER_RATIO_INDEX = FEATURE_NAMES.indexOf('low_register_ratio');
/** Index of `silence_ratio`, read by the decoder's link rule. */
export const SILENCE_RATIO_INDEX = FEATURE_NAMES.indexOf('silence_ratio');

/** Sub-window bin used for polyphony spread and silence-ratio estimates. */
export const POLYPHONY_BIN_SEC = 0.25;
/** Sub-window bin used for onset regularity (autocorrelation) estimates. */
export const REGULARITY_BIN_SEC = 0.1;

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
  /** Total prototype budget across all labels (default 16000). */
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
   * Draw `__none__` training windows only from files marked complete (default
   * true). An unannotated window asserts "no song" only where the user declared
   * the file finished. In an unfinished file it is unreviewed time, most of it
   * real playing, and often a take of a song the user has not annotated yet;
   * training on it teaches the model that song is silence. See the v2.12 entry
   * in `ml/CHANGELOG.md` for the measurements, including what it costs: a
   * narrower `__none__` class labels some practice drills as songs.
   *
   * Fit-only: the decoder never reads it, so it cannot move a saved model.
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


export interface SongRangeSuggestion {
  songName: string;
  /** Share of the range's confident window evidence assigned to this song. */
  confidence: number;
}
