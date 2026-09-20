import { hasFlag, parseInt_, parseNum, pct, readArg, resolveDbPath, runMain } from '@core/cli/args';
import { closeDatabase, getDb, initializeDatabase } from '../config/database';

/**
 * Refit the display-only confidence calibration in
 * `src/utils/predictionConfidence.ts`.
 *
 * The model's stored `predicted_confidence` is a decoder evidence margin, not
 * a probability, and against human review verdicts it runs *backwards*: long
 * correct takes average toward a modest margin while short spurious segments
 * keep a high one. This script fits a logistic over `[1, margin,
 * log10(durationSec)]` against the reviewed rows so the UI can show a number
 * that moves with reliability instead of against it.
 *
 * It reads the database and prints weights. It writes nothing -- paste the
 * printed block into `CONFIDENCE_WEIGHTS` and update the fit-quality comment
 * beside it, so the shipped constants always name the population they came
 * from. Nothing here touches the model: see the header of
 * `src/utils/predictionConfidence.ts` for why the raw margin scale must not
 * move.
 */

interface ReviewRow {
  margin: number;
  durationSec: number;
  good: number;
}

const FEATURE_COUNT = 3;

function usage() {
  console.log(`
Refit the display-only prediction-confidence calibration.

Usage:
  npm run ml:fit-confidence -- [options]

Options:
  --db <path>       SQLite DB path (default: data/jamcoda.db)
  --l2 <float>      L2 penalty on the non-bias weights (default: 1)
  --iterations <n>  Gradient descent steps (default: 4000)
  --folds <n>       Cross-validation folds (default: 5, 0 disables)
  --help            Show this help
`);
}

/** `[1, margin, log10(seconds)]`, matching the shipped scorer exactly. */
function features(row: Pick<ReviewRow, 'margin' | 'durationSec'>): number[] {
  return [1, row.margin, Math.log10(Math.max(1, row.durationSec))];
}

function logistic(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

function predict(weights: number[], row: Pick<ReviewRow, 'margin' | 'durationSec'>): number {
  const x = features(row);
  let z = 0;
  for (let i = 0; i < FEATURE_COUNT; i++) z += weights[i] * x[i];
  return logistic(z);
}

/** Batch gradient descent. The dataset is a few hundred rows; this is ample. */
function fit(rows: ReviewRow[], iterations: number, l2: number, learningRate = 0.5): number[] {
  const weights = new Array<number>(FEATURE_COUNT).fill(0);
  const cached = rows.map((row) => ({ x: features(row), y: row.good }));

  for (let step = 0; step < iterations; step++) {
    const gradient = new Array<number>(FEATURE_COUNT).fill(0);
    for (const { x, y } of cached) {
      let z = 0;
      for (let i = 0; i < FEATURE_COUNT; i++) z += weights[i] * x[i];
      const error = logistic(z) - y;
      for (let i = 0; i < FEATURE_COUNT; i++) gradient[i] += error * x[i];
    }
    for (let i = 0; i < FEATURE_COUNT; i++) {
      // The bias is unpenalized so the fit can still match the base rate.
      const penalty = i === 0 ? 0 : l2 * weights[i];
      weights[i] -= (learningRate * (gradient[i] + penalty)) / rows.length;
    }
  }
  return weights;
}

/** Probability a random positive outscores a random negative; 0.5 is chance. */
function areaUnderRoc(rows: ReviewRow[], weights: number[]): number | null {
  const positive = rows.filter((row) => row.good === 1).map((row) => predict(weights, row));
  const negative = rows.filter((row) => row.good === 0).map((row) => predict(weights, row));
  if (positive.length === 0 || negative.length === 0) return null;

  let concordant = 0;
  for (const p of positive) {
    for (const n of negative) {
      if (p > n) concordant++;
      else if (p === n) concordant += 0.5;
    }
  }
  return concordant / (positive.length * negative.length);
}

/** Deterministic fold assignment, so a rerun on the same data reproduces. */
function crossValidate(rows: ReviewRow[], folds: number, iterations: number, l2: number): number[] {
  const scores: number[] = [];
  for (let fold = 0; fold < folds; fold++) {
    const test = rows.filter((_, idx) => idx % folds === fold);
    const train = rows.filter((_, idx) => idx % folds !== fold);
    if (test.length === 0 || train.length === 0) continue;
    const auc = areaUnderRoc(test, fit(train, iterations, l2));
    if (auc !== null) scores.push(auc);
  }
  return scores;
}

function reportCalibration(rows: ReviewRow[], weights: number[]) {
  const buckets = new Map<number, number[]>();
  for (const row of rows) {
    const bucket = Math.min(0.8, Math.floor(predict(weights, row) * 5) / 5);
    const list = buckets.get(bucket) ?? [];
    list.push(row.good);
    buckets.set(bucket, list);
  }

  console.log('\nIn-sample calibration (predicted band vs. actual confirm rate):');
  for (const bucket of [...buckets.keys()].sort((a, b) => a - b)) {
    const values = buckets.get(bucket)!;
    const actual = values.reduce((sum, value) => sum + value, 0) / values.length;
    console.log(
      `  predicted ${pct(bucket)}-${pct(bucket + 0.2)}: n=${String(values.length).padStart(3)}`
      + ` actual confirmed ${pct(actual)}`
    );
  }
}

async function main() {
  if (hasFlag('--help')) {
    usage();
    return;
  }

  const dbPath = resolveDbPath();
  const l2 = Math.max(0, parseNum(readArg('--l2'), 1));
  const iterations = parseInt_(readArg('--iterations'), 4000);
  const folds = Math.max(0, Math.floor(parseNum(readArg('--folds'), 5)));

  process.env.JAMCODA_DB_PATH = dbPath;
  initializeDatabase();

  try {
    // `unsure` is the default status, not a verdict, so those rows carry no
    // label. An edited review confirms the song and corrects the bounds, which
    // is a hit for the purpose of this display.
    const rows = getDb().prepare(`
      SELECT predicted_confidence AS margin,
             predicted_end_time - predicted_start_time AS durationSec,
             CASE WHEN status IN ('confirmed', 'edited') THEN 1 ELSE 0 END AS good
      FROM prediction_reviews
      WHERE status <> 'unsure' AND predicted_confidence IS NOT NULL
      ORDER BY id
    `).all() as ReviewRow[];

    if (rows.length < 30) {
      throw new Error(
        `Only ${rows.length} reviewed prediction(s). Review more before refitting;`
        + ' the shipped weights are better than a fit on this little data.'
      );
    }

    const good = rows.reduce((sum, row) => sum + row.good, 0);
    console.log(`Database: ${dbPath}`);
    console.log(`Reviewed rows: ${rows.length} (${good} confirmed/edited, ${rows.length - good} invalid).`);

    const weights = fit(rows, iterations, l2);
    const inSample = areaUnderRoc(rows, weights);

    if (folds > 1) {
      const cv = crossValidate(rows, folds, iterations, l2);
      const mean = cv.reduce((sum, value) => sum + value, 0) / cv.length;
      console.log(
        `\n${folds}-fold CV AUC: ${cv.map((value) => value.toFixed(3)).join(' / ')}`
        + ` (mean ${mean.toFixed(3)})`
      );
    }
    console.log(`In-sample AUC: ${inSample === null ? 'n/a' : inSample.toFixed(3)}`
      + ' (0.5 is chance; the raw margin alone scored 0.671 on the 2026-09-09 data).');

    reportCalibration(rows, weights);

    console.log('\nPaste into CONFIDENCE_WEIGHTS in src/utils/predictionConfidence.ts:');
    console.log('export const CONFIDENCE_WEIGHTS = {');
    console.log(`  bias: ${weights[0].toFixed(4)},`);
    console.log(`  margin: ${weights[1].toFixed(4)},`);
    console.log(`  logDuration: ${weights[2].toFixed(4)}`);
    console.log('} as const');
    if (weights[1] > 0) {
      console.log(
        '\nNote: the margin weight is positive, so the raw decoder margin is no longer'
        + ' anti-correlated with review verdicts on this data. Worth understanding why'
        + ' before shipping it -- see ml/CHANGELOG.md.'
      );
    }
    console.log('\nAlso update the fit-quality comment beside the weights: the numbers there'
      + ' name the population they came from, and a stale one is worse than none.');
  } finally {
    closeDatabase();
  }
}

runMain('Confidence calibration fit failed', main);
