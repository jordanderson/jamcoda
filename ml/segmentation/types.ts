/**
 * Shared shapes and tuning constants for song segmentation.
 *
 * Kept apart from the code that uses them so config, features, model and
 * decode can all import from one place without cycles.
 */

export const NO_SONG_LABEL = '__none__';

/**
 * Human-readable model release stamp, written into every fitted model.
 * Bump it whenever the features, config resolution or decoding behavior that
 * a model captures change. `ml:eval` uses it (and the `createdAt` fallback)
 * to name its report files, so runs stay referable without manual renaming.
 * Keep `ml/CHANGELOG.md` in sync with each bump.
 */
export const MODEL_VERSION = 'v2.14';

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
 * A model trained with `chordIoiFeatures` appends `CHORD_IOI_FEATURE_NAMES`
 * to this list; `featureNamesFor` gives the list a config extracts.
 * `loadModel` rejects a model whose own `featureNames` disagree with that
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

/**
 * Opt-in chord-shape and rhythm-texture features (`chordIoiFeatures`):
 *   chordInterval_1..6   pairwise interval classes among pitch classes sounding
 *                        together, over seven sub-bins, normalized to sum 1
 *   ioi_*                inter-onset intervals in ten bins from under 80ms to
 *                        4s and over, normalized to sum 1; rhythm texture
 *                        without an absolute tempo
 */
export const CHORD_IOI_FEATURE_NAMES = [
  'chordInterval_1', 'chordInterval_2', 'chordInterval_3', 'chordInterval_4', 'chordInterval_5', 'chordInterval_6',
  'ioi_lt_80ms', 'ioi_80_150ms', 'ioi_150_250ms', 'ioi_250_400ms', 'ioi_400_650ms',
  'ioi_650_1000ms', 'ioi_1000_1500ms', 'ioi_1500_2500ms', 'ioi_2500_4000ms', 'ioi_ge_4000ms'
] as const;

/**
 * Opt-in center features (`centerWindowSec`): the base features again, over a
 * short window at the middle of each window, where the window's label applies.
 */
export const CENTER_FEATURE_NAMES = FEATURE_NAMES.map((name) => `center_${name}`);

/** The features a model with this config extracts, in vector order. */
export function featureNamesFor(
  config: Pick<TrainConfig, 'chordIoiFeatures' | 'centerWindowSec'>
): readonly string[] {
  return [
    ...FEATURE_NAMES,
    ...(config.chordIoiFeatures ? CHORD_IOI_FEATURE_NAMES : []),
    ...((config.centerWindowSec ?? 0) > 0 ? CENTER_FEATURE_NAMES : [])
  ];
}

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
   * dead air always has weak evidence, so one recognizable phrase could claim
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
   * Append `CHORD_IOI_FEATURE_NAMES` to each window's features. On by default
   * when training (v2.14). The model records it, so prediction extracts the
   * features the model was trained on; a model saved without it extracts the
   * base set, and `refitConfigOf` keeps it that way when such a model is
   * refit. See the v2.14 entry in `ml/CHANGELOG.md`.
   */
  chordIoiFeatures?: boolean;
  /**
   * Length in seconds of a shorter window centered in each window, whose base
   * features are appended as `CENTER_FEATURE_NAMES` (default 0, off; must be
   * under `windowSec`). The full window has enough notes to recognize a slow,
   * sparse song; the center one shows whether the middle of the window, where
   * its label applies, is still that song or a pause or noodling. The
   * model records it, and a model saved without it extracts no center features.
   */
  centerWindowSec?: number;
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
   * Rescue pass: an unlabeled span may be given to a neighboring song when
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
   * thing. An unlabeled region often is not: a take whose middle the model
   * half-recognizes runs straight into the dead air after it, and averaging the
   * two together rejects both. With a lookahead the span is claimed by creeping
   * inwards from each end while the *local* mean holds, so a song keeps the
   * part of the span its evidence actually covers and abandons the rest. The
   * two ends advance in lockstep, as unvouched tails do.
   */
  linkRescueLookaheadSec?: number;
  /**
   * Anchor-link decoder: a run of one song lasting at most this many seconds,
   * with a single other song's windows directly on both sides, is left
   * unlabeled. 0 disables.
   *
   * Such a run is almost always the model misreading a moment of the flanking
   * song, most often where a take restarts. It is dropped rather than given to
   * the flanking song because it is frequently the only mark of that restart,
   * and absorbing it merges the two takes. Only immediate adjacency counts, so
   * a real short piece with a pause on either side is untouched.
   *
   * `resolveTrainConfig` defaults this to 30, so every model built from v2.13
   * records it. The decoder reads an absent value as 0, which keeps an older
   * saved model decoding the way it was built. See the v2.13 entry in
   * `ml/CHANGELOG.md`.
   */
  dropFlankedRunSec?: number;
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
  /** v2: neighbors averaged per label in 'min' scoring, resolved at fit time. */
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

/**
 * How the decoder reached a window's song.
 *
 * `anchor`: recognized outright, in a run of windows whose top song beats the
 * runner-up by `anchorMargin`. Every other value is a song the window's own
 * evidence did not settle: `bridge`, between two anchor runs of that song;
 * `tail`, past a song's outermost anchor run; `linked`, legacy extension from
 * an anchor run; `divided`, a gap between two songs' anchors split by
 * `anchorGapPolicy`; `rescued`, a leftover span given to a neighbor by its mean
 * rank; `decoded`, any song from the viterbi or smooth decoders, which have no
 * anchors.
 */
export type WindowBasis = 'anchor' | 'bridge' | 'tail' | 'linked' | 'divided' | 'rescued' | 'decoded';

/** A stretch of a segment and how it was reached; `joined` is a gap closed by `mergeGapSec`. */
export type SegmentBasis = WindowBasis | 'joined';

export interface SegmentPart {
  startTime: number;
  endTime: number;
  basis: SegmentBasis;
  /**
   * Mean `WindowPrediction.rank` of the segment's song over the part's windows.
   * Absent for a `joined` part, which has no windows of its song.
   */
  meanRank?: number;
}

export interface WindowPrediction {
  startTime: number;
  endTime: number;
  label: string;
  confidence: number;
  /** Set on every window labeled with a song. */
  basis?: WindowBasis;
  /**
   * How many labels the model scored above this window's song: 0 where it was
   * the model's own first choice. Set by the anchor decoder on every window
   * labeled with a song.
   */
  rank?: number;
}

export interface SongSegment {
  songName: string;
  startTime: number;
  endTime: number;
  durationSec: number;
  confidence: number;
  /**
   * The segment's stretches in time order, covering it from start to end,
   * as decoded. A caller that trims or splits the segment afterwards must clip
   * them to match.
   */
  parts?: SegmentPart[];
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
