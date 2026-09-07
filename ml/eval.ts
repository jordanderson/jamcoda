import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  clamp, ensureDirForFile, hasFlag, parseNum, pct, readArg, resolveDbPath, roundTo
} from '@core/cli/args';
import {
  NO_SONG_LABEL,
  decoderIgnoredOptions,
  buildSamplesForFile,
  extractNotesFromMidi,
  loadAnnotatedMidiFiles,
  loadModel,
  predictWindowsFromSamples,
  decodeWindowScores,
  scoreWindowsFromSamples,
  resolveTrainConfig,
  trainModelFromSamples,
  windowsToSegments,
  type AnnotatedMidiFile,
  type PredictConfig,
  type TrainConfig
} from './songSegmentation.js';
import { datasetIdentity, digest, EvalScoreCache, scoringConfig, scoringSourceIdentity } from './evalCache.js';
import { matchBoundaries, summarizeBoundaries, type BoundaryMatch } from './boundaryEvaluation.js';

interface FileEvalRow {
  fileId: number;
  filename: string;
  evaluatedWindows: number;
  correctWindows: number;
  accuracy: number;
  missingPredictionWindows: number;
}

interface FileSegmentEvalRow {
  fileId: number;
  filename: string;
  annotationSec: number;
  matchedSec: number;
  annotationRecall: number;
  predictedSec: number;
  predictedMatchedSec: number;
  segmentPrecision: number;
  segmentCount: number;
}

interface SongSegmentEvalRow {
  songName: string;
  annotationSec: number;
  matchedSec: number;
  recall: number;
  predictedSec: number;
  matchedPredictedSec: number;
  precision: number;
  f1: number;
}

/**
 * Segment overlap between predictions and annotations, in seconds.
 *
 * Precision is only meaningful where the annotations are complete. In a file
 * the user has not finished annotating, most of the audio carries no
 * annotation at all, so a correct prediction there is counted as a false
 * positive: measured over the current library, precision is 85% on complete
 * files and 38% on incomplete ones, for the same model. Aggregating the two
 * yields a number that moves with annotation coverage rather than with the
 * model, and that barely responds to real model changes. Compare variants on
 * `segmentComplete`.
 */
interface SegmentEvalSummary {
  /** Files that contributed to this summary. */
  files: number;
  annotationSec: number;
  matchedSec: number;
  annotationRecall: number;
  predictedSec: number;
  matchedPredictedSec: number;
  segmentPrecision: number;
  segmentF1: number;
  segmentCount: number;
}

interface SongEvalRow {
  songName: string;
  support: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

interface EvalReport {
  dataset: ReturnType<typeof datasetIdentity>;
  modelSha256: string;
  scoringSourceSha256: string;
  trainConfig: TrainConfig;
  timingMs: Record<string, number>;
  scoreCache: { hits: number; misses: number; enabled: boolean };
  boundaryComplete: ReturnType<typeof summarizeBoundaries>;
  boundaryMatchesComplete: BoundaryMatch[];
  generatedAt: string;
  mode: 'insample' | 'loo';
  modelPath: string;
  /** Human-readable model release stamp, e.g. "v2.5". */
  modelVersion: string;
  /** The model's `createdAt`, so a report pins the exact artifact. */
  modelCreatedAt: string;
  dbPath: string;
  rootDir: string;
  includeNone: boolean;
  filesEvaluated: number;
  windowsEvaluated: number;
  windowsCorrect: number;
  windowAccuracy: number;
  missingPredictionWindows: number;
  predictConfig: {
    minWindowConfidence: number;
    smoothingWindows: number;
    minSegmentSec: number;
    minSegmentConfidence: number;
    mergeGapSec: number;
    modelWindowSec: number;
    modelStepSec: number;
    modelK: number;
  };
  segment: SegmentEvalSummary;
  /**
   * The same segment metrics restricted to files marked complete, and to the
   * files that are not. Read `segmentComplete` as the honest number: see the
   * note on `SegmentEvalSummary`.
   */
  segmentComplete: SegmentEvalSummary;
  segmentIncomplete: SegmentEvalSummary;
  byFile: FileEvalRow[];
  byFileSegment: FileSegmentEvalRow[];
  bySong: SongEvalRow[];
  bySongSegment: SongSegmentEvalRow[];
  topConfusions: Array<{
    trueLabel: string;
    predictedLabel: string;
    count: number;
  }>;
}

function usage() {
  console.log(`
Evaluate current model predictions against existing annotations.

By default this evaluates only windows whose ground truth is an annotated song
(excludes __none__ windows), and writes a JSON report.

Usage:
  npm run ml:eval -- [options]

Options:
  --model <path>                 Model file path (default: data/ml/model.json)
  --db <path>                    SQLite DB path (default: data/jamcoda.db)
  --root <path>                  Workspace root for resolving MIDI paths (default: .)
  --out <path>                   JSON output path (default: a stamped name like
                                 data/ml/eval-loo-v2.5-20260902-143000.json)
  --mode <insample|loo>          Eval mode (default: loo)
  --min-window-confidence <n>    Window confidence threshold (default: 0.45)
  --smoothing <int>              Smoothing windows (default: 5)
  --min-segment-sec <n>          Segment evaluation minimum duration (default: 8)
  --min-segment-confidence <n>   Segment evaluation confidence threshold (default: 0.3)
  --merge-gap-sec <n>            Segment evaluation merge gap (default: 5)
  --include-none                 Also evaluate __none__ windows
  --cache-dir <path>             Reuse per-fold scores (default: data/ml/eval-cache)
  --no-cache                     Disable score caching for timing/reference checks
  --expect-dataset <sha256>       Refuse a run against different annotations/MIDI
  --anchor-margin <n>            Override decoder seed margin without retraining
  --min-anchor-run <int>         Override minimum anchor run
  --fill-topk <int>              Override linking affinity (-1 disables)
  --link-max-silence <n>          Override silence linking limit
  --anchor-gap-policy <legacy|midpoint|evidence>  Experimental transition placement
  --link-policy <legacy|bridge>  Ambiguous-window linking rule
  --link-tail-sec <n>            Seconds an unvouched tail may run (bridge only)
  --link-rescue-rank <n>        Mean-rank span rescue; -1 disables (bridge default 5)
  --link-rescue-lookahead <n>   Seconds of lookahead for the rescue's mean rank;
                                0 tests the whole span at once (bridge default)
  --quiet                        Reduce per-file logging
  --help                         Show this help
`);
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Compact local timestamp for report filenames: `YYYYMMDD-HHmmss`.
 */
function timestampStem(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Default report path: mode + model release stamp + timestamp, so runs are
 * referable without copying or renaming. Old models without a
 * `modelVersion` fall back to `v<architecture version>`.
 */
function defaultReportPath(mode: EvalMode, modelVersion: string): string {
  return path.resolve('data/ml', `eval-${mode}-${modelVersion}-${timestampStem()}.json`);
}

type EvalMode = 'insample' | 'loo';

function parseMode(value: string | undefined): EvalMode {
  if (!value) return 'loo';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'insample' || normalized === 'loo') {
    return normalized;
  }
  throw new Error(`Invalid --mode value "${value}". Use "insample" or "loo".`);
}

interface SongStatsAccumulator {
  support: number;
  tp: number;
  fp: number;
  fn: number;
}

function getSongStatsAccumulator(
  map: Map<string, SongStatsAccumulator>,
  songName: string
): SongStatsAccumulator {
  let value = map.get(songName);
  if (!value) {
    value = { support: 0, tp: 0, fp: 0, fn: 0 };
    map.set(songName, value);
  }
  return value;
}

function rangeOverlap(
  aStart: number, aEnd: number, bStart: number, bEnd: number
): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function emptySegmentSummary(): SegmentEvalSummary {
  return {
    files: 0,
    annotationSec: 0,
    matchedSec: 0,
    annotationRecall: 0,
    predictedSec: 0,
    matchedPredictedSec: 0,
    segmentPrecision: 0,
    segmentF1: 0,
    segmentCount: 0
  };
}

const segmentSummary = emptySegmentSummary();
const segmentCompleteSummary = emptySegmentSummary();
const segmentIncompleteSummary = emptySegmentSummary();

function accumulateSegmentSummary(target: SegmentEvalSummary, row: FileSegmentEvalRow) {
  target.files++;
  target.annotationSec += row.annotationSec;
  target.matchedSec += row.matchedSec;
  target.predictedSec += row.predictedSec;
  target.matchedPredictedSec += row.predictedMatchedSec;
  target.segmentCount += row.segmentCount;
}

function finalizeSegmentSummary(target: SegmentEvalSummary) {
  target.annotationRecall = target.annotationSec > 0 ? target.matchedSec / target.annotationSec : 0;
  target.segmentPrecision = target.predictedSec > 0
    ? target.matchedPredictedSec / target.predictedSec
    : 0;
  const denominator = target.annotationRecall + target.segmentPrecision;
  target.segmentF1 = denominator > 0
    ? (2 * target.annotationRecall * target.segmentPrecision) / denominator
    : 0;
}

const byFileSegment: FileSegmentEvalRow[] = [];
const bySongSegment = new Map<string, SongSegmentEvalRow>();

function accumulateSongSegment(songName: string, annotationSec: number, matchedSec: number, predictedSec: number, matchedPredictedSec: number) {
  let row = bySongSegment.get(songName);
  if (!row) {
    row = { songName, annotationSec: 0, matchedSec: 0, recall: 0, predictedSec: 0, matchedPredictedSec: 0, precision: 0, f1: 0 };
    bySongSegment.set(songName, row);
  }
  row.annotationSec += annotationSec;
  row.matchedSec += matchedSec;
  row.predictedSec += predictedSec;
  row.matchedPredictedSec += matchedPredictedSec;
}

function evaluateFileSegments(
  file: AnnotatedMidiFile,
  segments: ReturnType<typeof windowsToSegments>
): FileSegmentEvalRow | null {
  let annotationSec = 0;
  let matchedSec = 0;
  let predictedSec = 0;
  let matchedPredictedSec = 0;

  for (const annotation of file.annotations) {
    const annLen = annotation.endTime - annotation.startTime;
    annotationSec += annLen;
    let overlap = 0;
    for (const segment of segments) {
      if (segment.songName === annotation.songName) {
        overlap += rangeOverlap(segment.startTime, segment.endTime, annotation.startTime, annotation.endTime);
      }
    }
    matchedSec += Math.min(overlap, annLen);
    accumulateSongSegment(annotation.songName, annLen, Math.min(overlap, annLen), 0, 0);
  }

  for (const segment of segments) {
    const segLen = segment.endTime - segment.startTime;
    predictedSec += segLen;
    let overlap = 0;
    for (const annotation of file.annotations) {
      if (annotation.songName === segment.songName) {
        overlap += rangeOverlap(segment.startTime, segment.endTime, annotation.startTime, annotation.endTime);
      }
    }
    matchedPredictedSec += Math.min(overlap, segLen);
    accumulateSongSegment(segment.songName, 0, 0, segLen, Math.min(overlap, segLen));
  }

  if (annotationSec === 0) return null;
  return {
    fileId: file.fileId,
    filename: file.filename,
    annotationSec,
    matchedSec,
    annotationRecall: matchedSec / annotationSec,
    predictedSec,
    predictedMatchedSec: matchedPredictedSec,
    segmentPrecision: predictedSec > 0 ? matchedPredictedSec / predictedSec : 0,
    segmentCount: segments.length
  };
}

async function main() {
  const startedAt = performance.now();
  const timingMs = { features: 0, fit: 0, score: 0, decode: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  if (hasFlag('--help')) {
    usage();
    return;
  }

  const modelPath = path.resolve(readArg('--model') || 'data/ml/model.json');
  const dbPath = resolveDbPath();
  const rootDir = path.resolve(readArg('--root') || '.');
  const outArg = readArg('--out');
  const includeNone = hasFlag('--include-none');
  const quiet = hasFlag('--quiet');
  const mode = parseMode(readArg('--mode'));

  const predictConfig: PredictConfig = {
    minWindowConfidence: clamp(parseNum(readArg('--min-window-confidence'), 0.45), 0, 1),
    smoothingWindows: Math.max(1, Math.floor(parseNum(readArg('--smoothing'), 5))),
    minSegmentSec: Math.max(0, parseNum(readArg('--min-segment-sec'), 8)),
    minSegmentConfidence: clamp(parseNum(readArg('--min-segment-confidence'), 0.3), 0, 1),
    mergeGapSec: Math.max(0, parseNum(readArg('--merge-gap-sec'), 5))
  };

  const model = loadModel(modelPath);
  const modelSha256 = digest(readFileSync(modelPath));
  const scoringSourceSha256 = scoringSourceIdentity();
  const numericOverrides = [
    ['--anchor-margin', 'anchorMargin', 0, Infinity, false],
    ['--min-anchor-run', 'minAnchorRun', 1, Infinity, true],
    ['--fill-topk', 'fillTopK', -1, Infinity, true],
    ['--link-max-silence', 'linkMaxSilenceRatio', 0, 1, false],
    ['--link-tail-sec', 'linkTailSec', 0, Infinity, false],
    ['--link-rescue-rank', 'linkRescueRank', -1, Infinity, false],
    ['--link-rescue-lookahead', 'linkRescueLookaheadSec', 0, Infinity, false]
  ] as const;
  for (const [flag, key, min, max, integer] of numericOverrides) {
    const raw = readArg(flag);
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new Error(`Invalid ${flag}: ${raw}`);
    }
    model.config[key] = value;
  }
  const gapPolicy = readArg('--anchor-gap-policy');
  if (gapPolicy !== undefined) {
    if (gapPolicy !== 'legacy' && gapPolicy !== 'midpoint' && gapPolicy !== 'evidence') {
      throw new Error('Invalid --anchor-gap-policy; use legacy, midpoint, or evidence.');
    }
    model.config.anchorGapPolicy = gapPolicy;
  }
  const linkPolicy = readArg('--link-policy');
  if (linkPolicy !== undefined) {
    if (linkPolicy !== 'legacy' && linkPolicy !== 'bridge') {
      throw new Error('Invalid --link-policy; use legacy or bridge.');
    }
    model.config.linkPolicy = linkPolicy;
  }
  if (mode === 'loo') model.config = resolveTrainConfig(model.config);
  const modelVersion = model.modelVersion ?? `v${model.version}`;
  const outPath = outArg ? path.resolve(outArg) : defaultReportPath(mode, modelVersion);
  const ignored = decoderIgnoredOptions(model.config.decoder);
  if (ignored.length > 0) {
    console.log(
      `Note: the '${model.config.decoder ?? 'anchor'}' decoder ignores ${ignored.join(' and ')}.`
      + ' Use --anchor-margin and --min-anchor-run instead.'
    );
  }
  const files = loadAnnotatedMidiFiles(dbPath, rootDir);
  if (files.length === 0) {
    throw new Error('No annotated files found in DB.');
  }
  const dataset = datasetIdentity(files);
  const expectedDataset = readArg('--expect-dataset');
  if (expectedDataset && expectedDataset !== dataset.sha256) {
    throw new Error(`Dataset changed: expected ${expectedDataset}, found ${dataset.sha256}.`);
  }
  const cache = hasFlag('--no-cache') ? undefined : new EvalScoreCache(
    path.resolve(readArg('--cache-dir') || 'data/ml/eval-cache'),
    {
      schema: 1, dataset: dataset.sha256, source: scoringSourceSha256, mode,
      config: scoringConfig(model.config),
      // LOO trains fresh folds: the saved prototypes and date are irrelevant.
      model: mode === 'insample' ? modelSha256 : undefined
    }
  );
  const scoreCache = { hits: 0, misses: 0, enabled: !!cache };
  const boundaryMatchesComplete: BoundaryMatch[] = [];
  let completeAnnotations = 0;
  let completePredictions = 0;
  const totalAnnotations = files.reduce((sum, file) => sum + file.annotations.length, 0);
  const windowsByFile = new Map<number, ReturnType<typeof buildSamplesForFile>>();
  const notesByFile = new Map<number, ReturnType<typeof extractNotesFromMidi>>();
  let totalTruthWindows = 0;

  console.log('Extracting window features from MIDI files...');
  const featuresStartedAt = performance.now();
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];
    const featureStartMs = Date.now();
    const notes = extractNotesFromMidi(file.midiPath);
    notesByFile.set(file.fileId, notes);
    const truthWindows = buildSamplesForFile(
      file,
      notes,
      {
        windowSec: model.config.windowSec,
        stepSec: model.config.stepSec,
        registerDivide: model.config.registerDivide ?? 60
      }
    );
    windowsByFile.set(file.fileId, truthWindows);
    totalTruthWindows += truthWindows.length;
    if (!quiet) {
      const elapsedSec = (Date.now() - featureStartMs) / 1000;
      console.log(
        `  [${fileIndex + 1}/${files.length}] ${file.filename}`
        + ` | windows=${formatCount(truthWindows.length)}`
        + ` | ${elapsedSec.toFixed(2)}s`
      );
    }
  }
  timingMs.features = performance.now() - featuresStartedAt;

  console.log('Starting evaluation...');
  console.log(`  model: ${modelPath} (${modelVersion}, ${model.createdAt})`);
  console.log(`  db: ${dbPath}`);
  console.log(`  root: ${rootDir}`);
  console.log(`  out: ${outPath}`);
  console.log(`  mode: ${mode}`);
  console.log(`  scope: ${includeNone ? 'all windows (including __none__)' : 'annotated windows only'}`);
  console.log(
    `  predict config: minWindowConfidence=${predictConfig.minWindowConfidence}, `
    + `smoothing=${predictConfig.smoothingWindows}`
  );
  console.log(
    `  model config: window=${model.config.windowSec}s, step=${model.config.stepSec}s, `
    + `k=${model.config.k}, labels=${model.labels.length}`
  );
  console.log(`  dataset: files=${formatCount(files.length)}, annotations=${formatCount(totalAnnotations)}`);
  console.log(`  total windows extracted=${formatCount(totalTruthWindows)}`);
  console.log(`  dataset sha256: ${dataset.sha256}`);

  const byFile: FileEvalRow[] = [];
  const confusion = new Map<string, number>();
  const songStats = new Map<string, SongStatsAccumulator>();

  let windowsEvaluated = 0;
  let windowsCorrect = 0;
  let missingPredictionWindows = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];
    const fileStartMs = Date.now();
    const truthWindows = windowsByFile.get(file.fileId) || [];
    let predictedWindows: ReturnType<typeof predictWindowsFromSamples> = [];
    let trainWindowCount = 0;

    const cacheStartedAt = performance.now();
    let scored = cache?.read(file.fileId, truthWindows.length);
    timingMs.cacheRead += performance.now() - cacheStartedAt;
    if (scored) scoreCache.hits++;
    else {
      scoreCache.misses++;
      let foldModel = model;
      if (mode === 'loo') {
        const fitStartedAt = performance.now();
        const trainSamples: ReturnType<typeof buildSamplesForFile> = [];
        for (const trainFile of files) {
          if (trainFile.fileId === file.fileId) continue;
          const trainWindows = windowsByFile.get(trainFile.fileId) || [];
          trainSamples.push(...trainWindows);
        }
        trainWindowCount = trainSamples.length;
        if (trainSamples.length === 0) {
          if (!quiet) {
            console.log(
              `[${fileIndex + 1}/${files.length}] ${file.filename} (#${file.fileId})`
              + ' | skipped: no training windows for LOO fold'
            );
          }
          continue;
        }

        foldModel = trainModelFromSamples(trainSamples, model.config);
        timingMs.fit += performance.now() - fitStartedAt;
      }
      const scoreStartedAt = performance.now();
      scored = { labels: foldModel.labels, scores: scoreWindowsFromSamples(foldModel, truthWindows) };
      timingMs.score += performance.now() - scoreStartedAt;
      const writeStartedAt = performance.now();
      cache?.write(file.fileId, scored);
      timingMs.cacheWrite += performance.now() - writeStartedAt;
    }
    const decodeStartedAt = performance.now();
    predictedWindows = decodeWindowScores(
      { config: model.config, labels: scored.labels }, truthWindows, scored.scores, predictConfig
    );
    timingMs.decode += performance.now() - decodeStartedAt;
    const predictedByStart = new Map<string, string>();
    for (const prediction of predictedWindows) {
      predictedByStart.set(roundTo(prediction.startTime).toFixed(6), prediction.label);
    }

    const windowsForEval = includeNone
      ? truthWindows
      : truthWindows.filter((window) => window.label !== NO_SONG_LABEL);

    let fileEvaluated = 0;
    let fileCorrect = 0;
    let fileMissing = 0;

    for (const window of windowsForEval) {
      const windowStartKey = roundTo(window.startTime).toFixed(6);
      const trueLabel = window.label;
      const predictedLabel = predictedByStart.get(windowStartKey) ?? NO_SONG_LABEL;

      fileEvaluated++;
      windowsEvaluated++;

      if (predictedLabel === trueLabel) {
        fileCorrect++;
        windowsCorrect++;
      }

      if (!predictedByStart.has(windowStartKey)) {
        fileMissing++;
        missingPredictionWindows++;
      }

      const confusionKey = `${trueLabel}\u0000${predictedLabel}`;
      confusion.set(confusionKey, (confusion.get(confusionKey) || 0) + 1);

      if (trueLabel !== NO_SONG_LABEL) {
        getSongStatsAccumulator(songStats, trueLabel).support++;
      }

      if (trueLabel === predictedLabel) {
        if (trueLabel !== NO_SONG_LABEL) {
          getSongStatsAccumulator(songStats, trueLabel).tp++;
        }
      } else {
        if (trueLabel !== NO_SONG_LABEL) {
          getSongStatsAccumulator(songStats, trueLabel).fn++;
        }
        if (predictedLabel !== NO_SONG_LABEL) {
          getSongStatsAccumulator(songStats, predictedLabel).fp++;
        }
      }
    }

    const fileNotes = notesByFile.get(file.fileId);
    const segments = windowsToSegments(predictedWindows, {
      minSegmentSec: predictConfig.minSegmentSec,
      minSegmentConfidence: predictConfig.minSegmentConfidence,
      mergeGapSec: predictConfig.mergeGapSec
    }, fileNotes);

    const fileSegmentRow = evaluateFileSegments(file, segments);
    if (file.isComplete) {
      completeAnnotations += file.annotations.length;
      completePredictions += segments.length;
      boundaryMatchesComplete.push(...matchBoundaries(file.fileId, file.annotations, segments));
    }
    if (fileSegmentRow) {
      byFileSegment.push(fileSegmentRow);
      accumulateSegmentSummary(segmentSummary, fileSegmentRow);
      accumulateSegmentSummary(
        file.isComplete ? segmentCompleteSummary : segmentIncompleteSummary,
        fileSegmentRow
      );
    }

    if (fileEvaluated > 0) {
      const fileRow: FileEvalRow = {
        fileId: file.fileId,
        filename: file.filename,
        evaluatedWindows: fileEvaluated,
        correctWindows: fileCorrect,
        accuracy: fileCorrect / fileEvaluated,
        missingPredictionWindows: fileMissing
      };
      byFile.push(fileRow);

      if (!quiet) {
        const elapsedSec = (Date.now() - fileStartMs) / 1000;
        console.log(
          `[${fileIndex + 1}/${files.length}] ${file.filename} (#${file.fileId})`
          + ` | truth=${formatCount(truthWindows.length)}`
          + (mode === 'loo' ? (trainWindowCount ? ` | train=${formatCount(trainWindowCount)}` : ' | cached scores') : '')
          + ` | predicted=${formatCount(predictedWindows.length)}`
          + ` | eval=${formatCount(fileRow.evaluatedWindows)}`
          + ` | acc=${pct(fileRow.accuracy)}`
          + ` | missing=${formatCount(fileRow.missingPredictionWindows)}`
          + ` | ${elapsedSec.toFixed(2)}s`
        );
      }
    } else if (!quiet) {
      const elapsedSec = (Date.now() - fileStartMs) / 1000;
      console.log(
        `[${fileIndex + 1}/${files.length}] ${file.filename} (#${file.fileId})`
        + ` | no windows in evaluation scope`
        + ` | ${elapsedSec.toFixed(2)}s`
      );
    }
  }

  if (windowsEvaluated === 0) {
    throw new Error('No evaluation windows found. Add more annotations or pass --include-none.');
  }

  const bySong: SongEvalRow[] = [...songStats.entries()]
    .map(([songName, stats]) => {
      const precision = stats.tp + stats.fp > 0 ? stats.tp / (stats.tp + stats.fp) : 0;
      const recall = stats.tp + stats.fn > 0 ? stats.tp / (stats.tp + stats.fn) : 0;
      const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
      return {
        songName,
        support: stats.support,
        tp: stats.tp,
        fp: stats.fp,
        fn: stats.fn,
        precision,
        recall,
        f1
      };
    })
    .sort((a, b) => b.support - a.support || b.f1 - a.f1 || a.songName.localeCompare(b.songName));

  const topConfusions = [...confusion.entries()]
    .map(([key, count]) => {
      const [trueLabel, predictedLabel] = key.split('\u0000');
      return { trueLabel, predictedLabel, count };
    })
    .filter((row) => row.trueLabel !== row.predictedLabel)
    .sort((a, b) => b.count - a.count)
    .slice(0, 40);
  const worstFiles = [...byFile]
    .sort((a, b) => a.accuracy - b.accuracy || b.evaluatedWindows - a.evaluatedWindows)
    .slice(0, 10);
  const worstSongsByRecall = [...bySong]
    .filter((row) => row.support >= 5)
    .sort((a, b) => a.recall - b.recall || b.support - a.support)
    .slice(0, 10);

  finalizeSegmentSummary(segmentSummary);
  finalizeSegmentSummary(segmentCompleteSummary);
  finalizeSegmentSummary(segmentIncompleteSummary);

  const bySongSegmentRows: SongSegmentEvalRow[] = [...bySongSegment.entries()]
    .map(([, row]) => {
      const recall = row.annotationSec > 0 ? row.matchedSec / row.annotationSec : 0;
      const precision = row.predictedSec > 0 ? row.matchedPredictedSec / row.predictedSec : 0;
      const f1 = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;
      return { ...row, recall, precision, f1 };
    })
    .sort((a, b) => b.annotationSec - a.annotationSec || a.songName.localeCompare(b.songName));

  // Detect edits to the live DB or MIDI while the run was in progress. A copied
  // DB (--db) is preferable for sweeps; never publish mixed-snapshot results.
  if (datasetIdentity(loadAnnotatedMidiFiles(dbPath, rootDir)).sha256 !== dataset.sha256) {
    throw new Error('Annotations or MIDI changed during evaluation. Re-run against a database snapshot.');
  }
  timingMs.total = performance.now() - startedAt;
  const report: EvalReport = {
    dataset, modelSha256, scoringSourceSha256, trainConfig: model.config, timingMs, scoreCache,
    boundaryComplete: summarizeBoundaries(boundaryMatchesComplete, completeAnnotations, completePredictions),
    boundaryMatchesComplete,
    generatedAt: new Date().toISOString(),
    mode,
    modelPath,
    modelVersion,
    modelCreatedAt: model.createdAt,
    dbPath,
    rootDir,
    includeNone,
    filesEvaluated: byFile.length,
    windowsEvaluated,
    windowsCorrect,
    windowAccuracy: windowsCorrect / windowsEvaluated,
    missingPredictionWindows,
    predictConfig: {
      minWindowConfidence: predictConfig.minWindowConfidence,
      smoothingWindows: predictConfig.smoothingWindows,
      minSegmentSec: predictConfig.minSegmentSec,
      minSegmentConfidence: predictConfig.minSegmentConfidence,
      mergeGapSec: predictConfig.mergeGapSec,
      modelWindowSec: model.config.windowSec,
      modelStepSec: model.config.stepSec,
      modelK: model.config.k
    },
    segment: segmentSummary,
    segmentComplete: segmentCompleteSummary,
    segmentIncomplete: segmentIncompleteSummary,
    byFile: byFile.sort((a, b) => a.fileId - b.fileId),
    byFileSegment: byFileSegment.sort((a, b) => a.fileId - b.fileId),
    bySong,
    bySongSegment: bySongSegmentRows,
    topConfusions
  };

  ensureDirForFile(outPath);
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\nEvaluation summary:');
  console.log(`  runtime=${(timingMs.total / 1000).toFixed(2)}s; score cache hits=${scoreCache.hits}, misses=${scoreCache.misses}`);
  const boundaries = report.boundaryComplete;
  console.log(`  complete-file boundaries: ${boundaries.matched}/${boundaries.annotations} annotations matched (mutual best IoU >= 0.5)`);
  if (boundaries.start && boundaries.end) {
    console.log(`  start/end mean absolute error=${boundaries.start.meanAbsoluteSec.toFixed(2)}s/${boundaries.end.meanAbsoluteSec.toFixed(2)}s;`
      + ` mean signed error=${boundaries.start.meanSignedSec.toFixed(2)}s/${boundaries.end.meanSignedSec.toFixed(2)}s (positive = late)`);
  }
  console.log(
    `  files=${formatCount(report.filesEvaluated)}`
    + ` windows=${formatCount(report.windowsEvaluated)}`
    + ` correct=${formatCount(report.windowsCorrect)}`
    + ` accuracy=${pct(report.windowAccuracy)}`
    + ` missingPredWindows=${formatCount(report.missingPredictionWindows)}`
  );
  const segmentLine = (label: string, summary: SegmentEvalSummary) => (
    `  ${label}`
    + ` recall=${pct(summary.annotationRecall)}`
    + ` precision=${pct(summary.segmentPrecision)}`
    + ` f1=${pct(summary.segmentF1)}`
    + ` (${formatCount(summary.files)} files,`
    + ` ${formatCount(summary.annotationSec)}s annotated,`
    + ` ${formatCount(summary.predictedSec)}s predicted,`
    + ` ${formatCount(summary.segmentCount)} segments)`
  );
  console.log('  segments vs annotations:');
  console.log(segmentLine('complete files  ', report.segmentComplete));
  console.log(segmentLine('incomplete files', report.segmentIncomplete));
  console.log(segmentLine('all files       ', report.segment));
  console.log(
    '  Compare model variants on the complete-files row. An incomplete file has'
    + ' unannotated time the user has not reviewed, so a correct prediction there'
    + ' still counts against precision.'
  );

  const worstSegmentFiles = [...byFileSegment]
    .sort((a, b) => a.annotationRecall - b.annotationRecall || b.annotationSec - a.annotationSec)
    .slice(0, 10);
  if (worstSegmentFiles.length > 0) {
    console.log('\nLowest annotation-recall files (top 10):');
    for (const row of worstSegmentFiles) {
      console.log(
        `  #${row.fileId} ${row.filename}`
        + ` | recall=${pct(row.annotationRecall)}`
        + ` | precision=${pct(row.segmentPrecision)}`
        + ` | ann=${formatCount(Math.round(row.annotationSec))}s`
        + ` | segs=${formatCount(row.segmentCount)}`
      );
    }
  }

  const worstSongsBySegmentRecall = bySongSegmentRows
    .filter((row) => row.annotationSec >= 60)
    .sort((a, b) => a.recall - b.recall || b.annotationSec - a.annotationSec)
    .slice(0, 10);
  if (worstSongsBySegmentRecall.length > 0) {
    console.log('\nLowest segment-recall songs (>=60s annotated, top 10):');
    for (const row of worstSongsBySegmentRecall) {
      console.log(
        `  ${row.songName}`
        + ` | recall=${pct(row.recall)}`
        + ` | precision=${pct(row.precision)}`
        + ` | f1=${pct(row.f1)}`
        + ` | ann=${formatCount(Math.round(row.annotationSec))}s`
      );
    }
  }

  if (worstFiles.length > 0) {
    console.log('\nLowest-accuracy files (top 10):');
    for (const row of worstFiles) {
      console.log(
        `  #${row.fileId} ${row.filename}`
        + ` | acc=${pct(row.accuracy)}`
        + ` | windows=${formatCount(row.evaluatedWindows)}`
        + ` | missing=${formatCount(row.missingPredictionWindows)}`
      );
    }
  }

  if (worstSongsByRecall.length > 0) {
    console.log('\nLowest-recall songs (support >= 5, top 10):');
    for (const row of worstSongsByRecall) {
      console.log(
        `  ${row.songName}`
        + ` | recall=${pct(row.recall)}`
        + ` | precision=${pct(row.precision)}`
        + ` | f1=${pct(row.f1)}`
        + ` | support=${formatCount(row.support)}`
      );
    }
  }

  if (report.topConfusions.length > 0) {
    console.log('\nTop confusions (top 10):');
    for (const row of report.topConfusions.slice(0, 10)) {
      console.log(`  ${row.trueLabel} -> ${row.predictedLabel}: ${formatCount(row.count)}`);
    }
  }

  console.log(`Wrote eval report to ${outPath}`);
}

main().catch((error) => {
  console.error('Eval failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
