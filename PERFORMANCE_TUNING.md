# Performance Tuning: training, inference, and parallel evals

Analysis of where `npm run ml:eval` and `npm run ml:train` spend their time, and
what is worth changing. Measured 2026-09-04 on an Apple M1 (4 performance + 4
efficiency cores, 16 GB) against the library at that date: 119 annotated files,
172,078 windows, 37 features, 64 labels.

This is a ranked worklist with the measurements that justify the ranking,
including the ideas that measured as *not* worth doing. Items 1 and 7 have
since been implemented; everything else is still open. Both were output-neutral
by construction, so results from before and after the change stay comparable.

## The shape of the problem

A leave-one-out eval is 119 folds. Each fold refits a model on all windows but
one file's, then scores that file's windows against every prototype. Everything
else — MIDI parsing, feature extraction, decoding, report assembly — is noise
by comparison.

Measured cost of a single fold, timed while two other evals were running:

| | concat | fit | predict (2,659 windows) | fold total |
| --- | --- | --- | --- | --- |
| `model.json`, budget 8000 (P=7,175) | 1 ms | 1,278 ms | 2,574 ms | 3.85 s |
| `tmp-variant-div72.json`, budget 24000 (P=21,312) | 1 ms | 3,372 ms | 11,581 ms | 14.95 s |

Fitting a line through `fit` across those two prototype counts separates it
into a P-independent base of **~215 ms** and **~0.148 ms per prototype**. That
per-prototype term is `estimateKernelScale`, and it is the first item below.

Feature extraction is not a factor: 4.7 s for all 119 files, once per process,
against a 12-19 minute run. A cross-process feature cache is not worth building.

## 1. `estimateKernelScale` is dead work in `min` score mode

**21-28% of every fold. IMPLEMENTED** — `min` mode now estimates from 50
samples instead of 800 (`ml/songSegmentation.ts:986-990`), keeping the field
populated while removing 15/16 of the cost. `avg` mode is unchanged at 800.
The measurements below describe the code as it was before that change.

`ml/songSegmentation.ts:981` runs `estimateKernelScale` on every fit: 800
sampled windows against every prototype. The result is read in exactly one
place, `ml/songSegmentation.ts:1184-1187`, inside the `scoreMode === 'avg'`
branch of `computePrototypeScores`. The shipped config is `scoreMode: 'min'`,
so under every default the value is computed and never read.

From the linear fit above, that is ~1.06 s of the 1.28 s fit at budget 8000
(83%), and ~3.16 s of the 3.37 s fit at budget 24000 (94%). As a share of the
whole fold: 28% at budget 8000, 21% at budget 24000. Multiply by 119 folds.

The fix is to compute it only when a caller will read it. Note that
`ml/songSegmentation.test.ts:127` asserts `model.kernelScale > 0`, so the field
must stay populated — either lazily, or with a much smaller sample count when
the mode cannot read it.

## 2. Cache the per-fold score matrix

**The largest structural win. Turns decoder sweeps into sub-second runs.**

`predictWindowsFromSamples` (`ml/songSegmentation.ts:1632`) splits cleanly in
two: build `scoresList` (all of the cost), then `anchorLinkDecode` (nearly
free). Every parameter downstream of that split can be re-swept without
recomputing a single distance:

- `decoder`, `anchorMargin`, `minAnchorRun`, `fillMinMargin`, `fillTopK`,
  `linkConfidence`, `linkMaxSilenceRatio`
- `minWindowConfidence`, `smoothingWindows`
- `minSegmentSec`, `minSegmentConfidence`, `mergeGapSec`

Of the variants sitting in `data/ml/scratch/` from the 2026-09-04 sweep,
`arun2`, `arun4`, `margin12`, `margin18`, `s04b24k`, `s05b24k` and `s06b24k`
change nothing upstream of the score matrix. Seven of roughly seventeen runs
each paid 12-19 minutes to recompute an identical `scoresList`.

The matrix is 172,078 x 64 floats — 88 MB as f64, and highly compressible.
Key the cache on everything up to and including scoring: `windowSec`,
`stepSec`, `registerDivide`, `prototypeBudget`, `maxNonePrototypes`,
`maxNoneToSongRatio`, `featureScaling`, `handMaskAugmentFraction`,
`noneFromCompleteFilesOnly`, `scoreMode`, `scoreNeighbors`, plus a stamp for
the annotation set. `budget*`, `none*`, `neigh3` and `div72` genuinely need
rescoring. The anchor, margin, silence and threshold sweeps do not.

## 3. Two of eight cores are in use

The 119 folds are embarrassingly parallel and nothing in the loop is shared
mutable state. Two options:

- **More concurrent variant processes.** Memory is the binding constraint at
  ~650 MB - 1.35 GB resident each, so about six fit in 16 GB — but only four
  performance cores are worth saturating.
- **`node:worker_threads` inside one eval.** Better cache behaviour and one
  copy of the window features, especially with item 8 below.

One blocker for anything in-process: `ml/eval.ts:233-235` and `ml/eval.ts:257-258`
hold the accumulators (`segmentSummary`, `segmentCompleteSummary`,
`segmentIncompleteSummary`, `byFileSegment`, `bySongSegment`) as module-level
mutable state. Two evals cannot share a process until those move into the
function that owns a run.

## 4. Check the `nice` value on eval processes

The two evals running during this analysis were at `nice 5`; a plain shell on
the same machine is at `nice 0`. On Apple Silicon, reduced priority and
background QoS bias threads onto the efficiency cores, which are substantially
slower than the performance cores.

`data/ml/scratch/run-variant.sh` does not set it, so the value is inherited
from whatever launches the script. This was observed, not root-caused. If the
nice value is unintentional it is a large free win.

## 5. The train step in a LOO sweep is almost pure overhead

`data/ml/scratch/run-variant.sh` trains a variant model and then evals it. The
train half is nearly all waste, for a reason that is easy to miss.

**In `loo` mode, `ml/eval.ts` never reads the loaded model's prototypes.** It
uses the file for `model.config` (`ml/eval.ts:372-374`, `442`), plus
`modelVersion`, `createdAt` and `labels.length` for the report and log lines.
Every fold refits from scratch via `trainModelFromSamples(trainSamples,
model.config)`. So a 24-32 MB model file is written, re-read and discarded to
carry what is really a small config object.

Per variant that costs: a second full feature-extraction pass (4.7 s, on top of
the eval's own), one complete fit whose prototypes are thrown away (~3.4 s at
budget 24000), a 24 MB `JSON.stringify` (107 ms) and write, and a 24 MB parse
back in eval (90 ms). Call it ~10 s against a 12-19 minute run — about 1%, so
this is a tidiness win rather than a speed one. The disk cost is less trivial:
`data/ml/tmp-variant-*.json` stands at 474 MB, all of it models nothing reads.

The fix is to let `ml/eval.ts` accept the train flags directly (or a small
config file) and skip the train step entirely for LOO sweeps. `insample` mode
does use the prototypes, so this has to stay mode-aware.

Two related notes:

- **`--skip-eval` is already handled.** `ml/train.ts:159` runs
  `evaluateLeaveOneOut` by default, and the `rebuild-model` route does the same
  at `server/routes/predictionReviews.routes.ts:542` — but the route gates it
  behind `includeEvaluation`, and `run-variant.sh` already passes
  `--skip-eval`. Nothing in the current sweep pays for leave-one-out twice.
- **`saveModel` pretty-prints.** `ml/songSegmentation.ts:1559` uses
  `JSON.stringify(model, null, 2)` on a large numeric blob. Dropping the indent
  argument would cut those 474 MB substantially at no cost.

`evaluateLeaveOneOut` (`ml/songSegmentation.ts:1472`) remains a near-duplicate
of the fold loop in `ml/eval.ts`. They should share one implementation, both so
they cannot drift and so item 2 benefits both.

## 6. Flatten prototypes into one `Float64Array`

**~1.2-1.5x on the scoring loop.**

`model.prototypes` is an array of objects each holding a `number[]`, built by
`JSON.parse` of the model file, so the feature vectors are scattered across the
heap. Benchmarked against a flat, label-major `Float64Array`:

| | current (JSON-scattered objects) | flat f64 label-major |
| --- | --- | --- |
| P=7,175 | 534 us/window | 361 us/window |
| P=21,312 | 1,687 us/window | 1,428 us/window |

This also explains the super-linear scaling noted in
`ml/experiments-2026-09-03-addendum.md` ("wall time grows faster than the
prototype count"): 2.97x the prototypes cost 4.50x the predict time in the fold
measurement above, which is cache pressure, not arithmetic.

Sorting prototypes by label additionally lets the `min` branch of
`computePrototypeScores` (`ml/songSegmentation.ts:1201-1215`) track a scalar
best per label, instead of allocating `Array.from({ length: 64 }, () => [])`
per window and calling `.sort()` on every improvement.

## 7. `computeEvidence` builds a `rank` array nothing reads

**IMPLEMENTED** — `computeEvidence` now takes a `needRank` flag
(`ml/songSegmentation.ts:1335`, `1665`) and skips the sort when
`fillTopK < 0`. The `rank` array is still allocated zero-filled to keep
`WindowEvidence`'s shape; see the hardening note at the end of this section.

`computeEvidence` allocated a 64-element object array and sorted it for every
window, to fill `rank`. `rank` is read in exactly one place,
`ml/songSegmentation.ts:1412`, and only when `fillTopK >= 0`. The default is
`-1`.

Small next to items 1-3, but it was roughly 11 million object allocations per
eval for a value that is discarded.

**Hardening note.** `rank` is still handed out as a zero-filled array when
`needRank` is false, so a future reader that forgets the `fillTopK >= 0` guard
would silently see "every label is rank 0" rather than fail. Typing it
`rank?: number[]` on `WindowEvidence` would make the compiler enforce the
check. Not a bug today — `ml/songSegmentation.ts:1412` is the only reader and
it is guarded — but the failure mode is a wrong answer, not a crash.

## 8. Leave-one-out refits from scratch every fold

Two O(N) costs are paid 119 times over data that barely changes:

- `normalizeVector` (`ml/songSegmentation.ts:851`) allocates a fresh 37-element
  array per sample, 172,078 times per fold — about 20 million arrays per run.
  That is most of the 215 ms P-independent base and a large part of the
  1.35 GB resident set. Normalizing once into a shared matrix and having folds
  index into it removes both.
- `standardize` (`ml/songSegmentation.ts:797`) can be made exact and O(1) per
  fold by keeping global per-feature sums and sums of squares and subtracting
  the held-out file's contribution, rather than re-scanning every window.

A smaller one in the eval loop itself: `ml/eval.ts` keys predictions by
`roundTo(startTime).toFixed(6)`, building two strings per window and a string
Map. The windows are already in order; index alignment or a numeric key would
do.

## Measured and rejected

| idea | result | why |
| --- | --- | --- |
| `Float32Array` for prototype features | 599 us/window vs 361 for f64 at P=7,175 | Halves the working set but V8 converts to double on every load and there is no SIMD. Slower. |
| Early-exit partial distance | consistent regression | At 37 dimensions the per-dimension branch costs more than the truncation saves. |
| Gemm reformulation, `\|p\|^2 - 2q.p`, batched over windows | 1,104 us/window vs 815 for the direct loop | Same flop count, worse constant in plain JS. Would only pay off through a native BLAS. |
| Cross-process feature cache | 4.7 s of a 12-19 minute run | Feature extraction is not a measurable share of the run. |

## Expected combined effect

With items 1 and 7 landed, a fold should have lost roughly a fifth to a quarter
of its cost — about 1.0 s of the 3.85 s fold at budget 8000, and about 3.0 s of
the 14.95 s fold at budget 24000, nearly all of it from item 1. That is
projected from the measurements above, not re-measured; the next clean
comparison against an idle machine will confirm it.

Of what remains: item 6 would take another 1.2-1.5x off the scoring loop, item 2
removes the run entirely for decoder-parameter variants, and items 3 and 4
multiply whatever is left.

Order of remaining work, cheapest-first: 4 (a launch-script fix, not a code
change), then 6, then 3, then 2, then 8. Items 2 and 3 are the ones that change
how a sweep is run rather than how fast a fold is, and 8 is the one that makes
wide worker fan-out fit in memory. Item 5 is tidiness and disk, not speed —
do it when touching that code for another reason.
