import path from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  clamp, ensureDirForFile, hasFlag, parseNum, pct, readArg, resolveDbPath, roundTo
} from '@core/cli/args';
import {
  NO_SONG_LABEL,
  buildSamplesForFile,
  extractNotesFromMidi,
  loadAnnotatedMidiFiles,
  loadModel,
  predictWindowsFromSamples,
  trainModelFromSamples,
  windowsToSegments,
  type AnnotatedMidiFile,
  type PredictConfig
} from './songSegmentation.js';

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

interface SegmentEvalSummary {
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
  generatedAt: string;
  mode: 'insample' | 'loo';
  modelPath: string;
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
  --out <path>                   JSON output path (default: data/ml/eval-report.json)
  --mode <insample|loo>          Eval mode (default: insample)
  --min-window-confidence <n>    Window confidence threshold (default: 0.45)
  --smoothing <int>              Smoothing windows (default: 5)
  --min-segment-sec <n>          Segment evaluation minimum duration (default: 8)
  --min-segment-confidence <n>   Segment evaluation confidence threshold (default: 0.3)
  --merge-gap-sec <n>            Segment evaluation merge gap (default: 3)
  --include-none                 Also evaluate __none__ windows
  --quiet                        Reduce per-file logging
  --help                         Show this help
`);
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

type EvalMode = 'insample' | 'loo';

function parseMode(value: string | undefined): EvalMode {
  if (!value) return 'insample';
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

const segmentSummary: SegmentEvalSummary = {
  annotationSec: 0,
  matchedSec: 0,
  annotationRecall: 0,
  predictedSec: 0,
  matchedPredictedSec: 0,
  segmentPrecision: 0,
  segmentF1: 0,
  segmentCount: 0
};

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
  if (hasFlag('--help')) {
    usage();
    return;
  }

  const modelPath = path.resolve(readArg('--model') || 'data/ml/model.json');
  const dbPath = resolveDbPath();
  const rootDir = path.resolve(readArg('--root') || '.');
  const outPath = path.resolve(readArg('--out') || 'data/ml/eval-report.json');
  const includeNone = hasFlag('--include-none');
  const quiet = hasFlag('--quiet');
  const mode = parseMode(readArg('--mode'));

  const predictConfig: PredictConfig = {
    minWindowConfidence: clamp(parseNum(readArg('--min-window-confidence'), 0.45), 0, 1),
    smoothingWindows: Math.max(1, Math.floor(parseNum(readArg('--smoothing'), 5))),
    minSegmentSec: Math.max(0, parseNum(readArg('--min-segment-sec'), 8)),
    minSegmentConfidence: clamp(parseNum(readArg('--min-segment-confidence'), 0.3), 0, 1),
    mergeGapSec: Math.max(0, parseNum(readArg('--merge-gap-sec'), 3))
  };

  const model = loadModel(modelPath);
  const files = loadAnnotatedMidiFiles(dbPath, rootDir);
  if (files.length === 0) {
    throw new Error('No annotated files found in DB.');
  }
  const totalAnnotations = files.reduce((sum, file) => sum + file.annotations.length, 0);
  const windowsByFile = new Map<number, ReturnType<typeof buildSamplesForFile>>();
  let totalTruthWindows = 0;

  console.log('Extracting window features from MIDI files...');
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];
    const featureStartMs = Date.now();
    const notes = extractNotesFromMidi(file.midiPath);
    const truthWindows = buildSamplesForFile(
      file,
      notes,
      {
        windowSec: model.config.windowSec,
        stepSec: model.config.stepSec
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

  console.log('Starting evaluation...');
  console.log(`  model: ${modelPath}`);
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

    if (mode === 'insample') {
      predictedWindows = predictWindowsFromSamples(model, truthWindows, predictConfig);
    } else {
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

      const foldModel = trainModelFromSamples(trainSamples, model.config);
      predictedWindows = predictWindowsFromSamples(foldModel, truthWindows, predictConfig);
    }
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

    const segments = windowsToSegments(predictedWindows, {
      minSegmentSec: predictConfig.minSegmentSec,
      minSegmentConfidence: predictConfig.minSegmentConfidence,
      mergeGapSec: predictConfig.mergeGapSec
    });

    const fileSegmentRow = evaluateFileSegments(file, segments);
    if (fileSegmentRow) {
      byFileSegment.push(fileSegmentRow);
      segmentSummary.annotationSec += fileSegmentRow.annotationSec;
      segmentSummary.matchedSec += fileSegmentRow.matchedSec;
      segmentSummary.predictedSec += fileSegmentRow.predictedSec;
      segmentSummary.matchedPredictedSec += fileSegmentRow.predictedMatchedSec;
      segmentSummary.segmentCount += fileSegmentRow.segmentCount;
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
          + (mode === 'loo' ? ` | train=${formatCount(trainWindowCount)}` : '')
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

  segmentSummary.annotationRecall = segmentSummary.annotationSec > 0
    ? segmentSummary.matchedSec / segmentSummary.annotationSec
    : 0;
  segmentSummary.segmentPrecision = segmentSummary.predictedSec > 0
    ? segmentSummary.matchedPredictedSec / segmentSummary.predictedSec
    : 0;
  segmentSummary.segmentF1 = segmentSummary.annotationRecall + segmentSummary.segmentPrecision > 0
    ? (2 * segmentSummary.annotationRecall * segmentSummary.segmentPrecision)
      / (segmentSummary.annotationRecall + segmentSummary.segmentPrecision)
    : 0;

  const bySongSegmentRows: SongSegmentEvalRow[] = [...bySongSegment.entries()]
    .map(([, row]) => {
      const recall = row.annotationSec > 0 ? row.matchedSec / row.annotationSec : 0;
      const precision = row.predictedSec > 0 ? row.matchedPredictedSec / row.predictedSec : 0;
      const f1 = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;
      return { ...row, recall, precision, f1 };
    })
    .sort((a, b) => b.annotationSec - a.annotationSec || a.songName.localeCompare(b.songName));

  const report: EvalReport = {
    generatedAt: new Date().toISOString(),
    mode,
    modelPath,
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
    byFile: byFile.sort((a, b) => a.fileId - b.fileId),
    byFileSegment: byFileSegment.sort((a, b) => a.fileId - b.fileId),
    bySong,
    bySongSegment: bySongSegmentRows,
    topConfusions
  };

  ensureDirForFile(outPath);
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\nEvaluation summary:');
  console.log(
    `  files=${formatCount(report.filesEvaluated)}`
    + ` windows=${formatCount(report.windowsEvaluated)}`
    + ` correct=${formatCount(report.windowsCorrect)}`
    + ` accuracy=${pct(report.windowAccuracy)}`
    + ` missingPredWindows=${formatCount(report.missingPredictionWindows)}`
  );
  console.log(
    '  segments vs annotations:'
    + ` recall=${pct(report.segment.annotationRecall)}`
    + ` precision=${pct(report.segment.segmentPrecision)}`
    + ` f1=${pct(report.segment.segmentF1)}`
    + ` (${formatCount(report.segment.annotationSec)}s annotated,`
    + ` ${formatCount(report.segment.predictedSec)}s predicted,`
    + ` ${formatCount(report.segment.segmentCount)} segments)`
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
