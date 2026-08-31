import path from 'node:path';
import { clamp, ensureDirForFile, hasFlag, parseInt_, parseNum, readArg, runMain } from '@core/cli/args';
import {
  loadModel,
  predictWindows,
  windowsToSegments,
  type PredictConfig
} from './songSegmentation.js';
import { writeFileSync } from 'node:fs';

interface OutputPayload {
  generatedAt: string;
  midiPath: string;
  modelPath: string;
  config: PredictConfig & {
    windowSec: number;
    stepSec: number;
    k: number;
  };
  segments: Array<{
    songName: string;
    startTime: number;
    endTime: number;
    durationSec: number;
    confidence: number;
  }>;
}

function usage() {
  console.log(`
Predict song ranges for a MIDI file.

Usage:
  npm run ml:predict -- --midi <path> [options]

Options:
  --model <path>              Model file path (default: data/ml/model.json)
  --midi <path>               MIDI file to analyze (required)
  --out <path>                Optional JSON output file path
  --min-window-confidence <n> Confidence threshold for each window (default: 0.45)
  --smoothing <int>           Number of windows for majority smoothing (default: 5)
  --min-segment-sec <n>       Minimum segment duration in seconds (default: 8)
  --min-segment-confidence <n> Minimum average segment confidence (default: 0.3)
  --merge-gap-sec <n>         Merge adjacent same-song segments within this gap (default: 3)
  --help                      Show this help
`);
}

async function main() {
  if (hasFlag('--help')) {
    usage();
    return;
  }

  const midiArg = readArg('--midi');
  if (!midiArg) {
    usage();
    throw new Error('Missing required --midi path.');
  }

  const modelPath = path.resolve(readArg('--model') || 'data/ml/model.json');
  const midiPath = path.resolve(midiArg);
  const outPathArg = readArg('--out');
  const outPath = outPathArg ? path.resolve(outPathArg) : undefined;

  const config: PredictConfig = {
    minWindowConfidence: parseNum(readArg('--min-window-confidence'), 0.45),
    smoothingWindows: parseInt_(readArg('--smoothing'), 5),
    minSegmentSec: Math.max(0, parseNum(readArg('--min-segment-sec'), 8)),
    minSegmentConfidence: clamp(parseNum(readArg('--min-segment-confidence'), 0.3), 0, 1),
    mergeGapSec: Math.max(0, parseNum(readArg('--merge-gap-sec'), 3))
  };

  const model = loadModel(modelPath);
  const windows = predictWindows(model, midiPath, config);
  const segments = windowsToSegments(windows, {
    minSegmentSec: config.minSegmentSec,
    minSegmentConfidence: config.minSegmentConfidence,
    mergeGapSec: config.mergeGapSec
  });

  if (segments.length === 0) {
    console.log('No confident song segments detected with current thresholds.');
  } else {
    console.log(`Predicted ${segments.length} segment(s):`);
    for (const segment of segments) {
      console.log(
        `  ${segment.songName}`
        + ` | ${segment.startTime.toFixed(1)}s - ${segment.endTime.toFixed(1)}s`
        + ` | dur=${segment.durationSec.toFixed(1)}s`
        + ` | conf=${segment.confidence.toFixed(2)}`
      );
    }
  }

  if (outPath) {
    const payload: OutputPayload = {
      generatedAt: new Date().toISOString(),
      midiPath,
      modelPath,
      config: {
        ...config,
        windowSec: model.config.windowSec,
        stepSec: model.config.stepSec,
        k: model.config.k
      },
      segments
    };
    ensureDirForFile(outPath);
    writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`Wrote prediction JSON to ${outPath}`);
  }
}

runMain('Prediction failed', main);

