import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { ensureDirForFile, hasFlag, parseInt_, readArg } from '@core/cli/args';
import { compareReports, type ComparableReport } from './evalComparison';
import { errorMessage } from '@core/errors';

/**
 * Paired comparison of two `ml:eval` reports.
 *
 * `ml:eval` reports an aggregate for one run. Deciding whether a decoder change
 * helped needs the two runs held against each other on the annotations both
 * recognized, which is what this prints. It reads reports only; it never
 * touches the database or the model.
 */

function usage(): void {
  console.log(`
Usage: npm run ml:compare -- --baseline <report.json> --variant <report.json> [options]

Options:
  --baseline <path>     Report to compare against (required)
  --variant <path>      Report under test (required)
  --out <path>          Write the full comparison, including every transition, as JSON
  --resamples <int>     File bootstrap resamples (default: 3000)
  --seed <int>          Bootstrap seed (default: 42)
  --max-gap-sec <n>     Largest annotation gap counted as a close transition (default: 2)
  --help                Show this help
`);
}

function load(flag: string): ComparableReport {
  const value = readArg(flag);
  if (!value) throw new Error(`Missing ${flag}`);
  const report = JSON.parse(readFileSync(path.resolve(value), 'utf8')) as ComparableReport;
  for (const field of ['dataset', 'segmentComplete', 'byFileSegment', 'boundaryMatchesComplete'] as const) {
    if (!report[field]) {
      throw new Error(`${value} has no \`${field}\`. Regenerate it with the current ml:eval.`);
    }
  }
  return report;
}

const sec = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}s`;

async function main() {
  if (hasFlag('--help')) {
    usage();
    return;
  }
  const baseline = load('--baseline');
  const variant = load('--variant');
  const result = compareReports(baseline, variant, {
    resamples: parseInt_(readArg('--resamples'), 3000),
    seed: parseInt_(readArg('--seed'), 42, 0),
    maxGapSec: Number(readArg('--max-gap-sec') ?? 2)
  });

  console.log(`dataset ${result.datasetSha256}`);
  console.log();
  console.log('Complete-file segment F1');
  console.log(`  baseline ${result.f1.baselinePoints.toFixed(3)}  variant ${result.f1.variantPoints.toFixed(3)}`
    + `  delta ${result.f1.deltaPoints >= 0 ? '+' : ''}${result.f1.deltaPoints.toFixed(3)} points`);
  console.log(`  file bootstrap 95% [${result.f1.ci95[0].toFixed(3)}, ${result.f1.ci95[1].toFixed(3)}]`
    + ` (${result.f1.resamples} resamples, seed ${result.f1.seed})`);
  console.log();
  console.log('Matched annotations (mutual best same-song overlap, IoU >= 0.5)');
  console.log(`  baseline ${result.matches.baseline}  variant ${result.matches.variant}`
    + `  common ${result.matches.common}  lost ${result.matches.lostByVariant}  gained ${result.matches.gainedByVariant}`);
  console.log();
  console.log(`Boundary error on the ${result.matches.common} annotations both runs matched (positive = late)`);
  for (const [name, paired] of [['start', result.paired.startErrorSec], ['end', result.paired.endErrorSec]] as const) {
    console.log(`  ${name.padEnd(5)} mean absolute ${paired.baselineMeanAbsoluteSec.toFixed(2)}s ->`
      + ` ${paired.variantMeanAbsoluteSec.toFixed(2)}s`
      + ` | median signed ${sec(paired.baselineMedianSignedSec)} -> ${sec(paired.variantMedianSignedSec)}`
      + ` | improved ${paired.improved}, worsened ${paired.worsened}, unchanged ${paired.unchanged}`);
  }
  console.log();
  const close = result.closeTransitions;
  console.log(`Close different-song transitions both runs matched at both ends: ${close.count}`);
  if (close.count > 0) {
    console.log(`  median ending error    ${sec(close.baselineMedianEndSec)} -> ${sec(close.variantMedianEndSec)}`);
    console.log(`  median next-start error ${sec(close.baselineMedianNextStartSec)} -> ${sec(close.variantMedianNextStartSec)}`);
  }

  const outArg = readArg('--out');
  if (outArg) {
    const outPath = path.resolve(outArg);
    ensureDirForFile(outPath);
    writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(`\nWrote comparison to ${outPath}`);
  }
}

main().catch((error) => {
  console.error('Compare failed:', errorMessage(error));
  process.exitCode = 1;
});
