# Addendum, 2026-09-03: the evaluation scope was wrong, and what it was hiding

This is a follow-up to [`experiments-2026-09-03.md`](./experiments-2026-09-03.md).
Everything below is full leave-one-file-out over the whole annotated library
(111 files, 718 annotations), run through a harness that reproduces
`ml/eval.ts` exactly — its first row for every table below matches the
committed pipeline's report to the last decimal, and the accepted configuration
was re-run through `npm run ml:eval` itself as a final check
(`data/ml/eval-loo-v2.10-final.json`: complete-files recall 89.5%, precision
86.9%, F1 88.2% against the harness's 89.48 / 86.86 / 88.15).

## 1. The headline result

**Segment precision was never measuring the model.** It was measuring how much
of the library has been annotated.

Split the same leave-one-out run by whether a file is marked complete:

| population | files | audio annotated | recall | precision | F1 |
| --- | --- | --- | --- | --- | --- |
| complete files | 71 | 87.7% | 85.87% | **85.52%** | **85.69%** |
| incomplete files | 40 | 37.2% | 87.24% | **38.04%** | 52.98% |
| all files (what the changelog reports) | 111 | 57.0% | 86.41% | 56.99% | 68.68% |

Same model, same fold, same code. Recall is within 1.4 pt across the two
populations, so the classification problem is equally hard in both. Precision
differs by **47 points**, because in an incomplete file 63% of the audio has no
annotation to match against, and a correct prediction there is scored as a
false positive.

Three independent lines of evidence say the incomplete-file predictions are
mostly right:

1. **The review queue.** 337 predictions have a human verdict on them. By
   duration, **85.5% were confirmed or edited rather than marked invalid** —
   the same number as complete-file precision, and nothing like 38%. (Every
   reviewed row sits on an incomplete file, because marking a file complete
   clears its review rows.)
2. **Shape of the miss.** Of the 56,514s of predicted time that lands outside
   any annotation, only 20.5% is contiguous with a same-song annotation
   (over-extension past a real boundary). The other 79.5% is isolated runs with
   a **median length of 91s** — the length of a take, not of a decoder error.
3. **Wrong-song error is tiny.** Of all predicted seconds, 57.0% match a
   same-song annotation, 40.1% land in unannotated gaps, and only **2.9%** land
   inside an annotation naming a different song.

### Why this matters beyond bookkeeping

The mixed metric is nearly blind. Across window lengths 4s to 8s it moves
between 67.7% and 68.7% — under a point, and non-monotone, which reads as
noise. The complete-files metric moves from 83.1% to 86.4% over the same sweep,
monotone in the first half. Precision losses on incomplete files were
cancelling real recall gains, so the sweep looked flat when it was not.

`ml/eval.ts` now reports all three rows and names the complete-files row as the
one to compare variants on.

### Correction to the main experiment log

The window-duration table in `experiments-2026-09-03.md` is labeled "73-File
Full LOO", but the only eval reports on disk for those configurations are
111-file runs, and their values differ substantially — the 6.0s row is reported
as 84.98% accuracy / 64.52% F1 while `eval-loo-v2.8-20260903-110714.json` (the
only 6.0s run) records 88.07% / 68.54%. The database holds 718 annotations
across 111 annotated files and `ml:eval` has no flag that restricts the file
set, so a 73-file run of those configurations could not have been produced on
that date. The relaxed-margin table likewise does not match what re-running
those settings produces (measured below). The qualitative conclusions of both
experiments reproduce; the numbers do not. Treat those tables as unverified.

## 2. New model changes, measured

All rows: complete-files scope, LOO, 111 files. Each row adds to the one above.

| change | acc | recall | precision | F1 | vs baseline |
| --- | --- | --- | --- | --- | --- |
| committed v2.8 (win 4, minmax, budget 2000) | 79.10 | 79.60 | 86.89 | 83.08 | — |
| + z-score scaling | 82.38 | 82.86 | 86.18 | 84.49 | +1.41 |
| + window 5s (**the in-flight v2.9**) | 85.17 | 85.87 | 85.52 | 85.69 | +2.61 |
| + window 6s | 85.91 | 86.35 | 84.77 | 85.55 | +2.47 |
| + prototype budget 8000 | 89.32 | 89.48 | 86.38 | 87.90 | +4.82 |
| + silence-blocked linking | 89.29 | 89.48 | 86.86 | **88.15** | **+5.07** |

### 2a. The in-flight v2.9 change is real, and it is the scaling

Ablated: z-score alone at window 4 gives +1.41 F1; window 5 alone under minmax
gives −0.03 (84.14 vs 83.08 — accuracy rises 4.4 pt but precision falls 2.8).
The two together give +2.61. Window length only pays off once the features are
z-scored, which fits: min-max maps each feature onto [0,1] using the extremes
of the training set, so a single outlier window compresses the useful range of
that feature, and the longer window makes outliers rarer but does nothing about
the compression.

### 2b. Trusted `__none__` sampling — the idea that did not survive its control

This one is worth reading in full, because it looked like the best result of the
day for about an hour.

Training labels every unannotated window of an annotated file `__none__`. That
is a statement the user made in a complete file. In an incomplete file it is an
assumption, and section 1 shows it is wrong roughly 85% of the time. The
negative class was being taught with about **62,000 windows of real performances
of songs the model already knows, labeled as silence** — the exact shape of the
dominant error the last three releases were chasing (`Song -> __none__`).

At the then-current `prototypeBudget` of 2000, dropping those windows measured
as the only change all day that raised accuracy, recall *and* precision at once:

| | acc | recall | precision | F1 |
| --- | --- | --- | --- | --- |
| win 5, budget 2000 | 85.17 | 85.87 | 85.52 | 85.69 |
| win 5, budget 2000, trusted `__none__` | 86.49 | 86.72 | 86.32 | **86.52** |

**But budgets are shares, not absolutes.** Withholding ~62k windows lowers
`__none__`'s `sqrt(support)`, so every song's share of the fixed budget goes up.
Trained both ways at budget 8000: `__none__` keeps exactly 60 prototypes either
way (the `maxNonePrototypes` cap binds), while song prototypes rise from 7,035
to 7,650 — **+8.7%**. So the change was partly a disguised budget increase, and
the budget sweep in 2d shows budget is the strongest lever in the whole study.

Re-run at a budget where songs are no longer starved, it reverses:

| | acc | recall | precision | F1 |
| --- | --- | --- | --- | --- |
| win 6, budget 8000 | 89.32 | 89.48 | 86.38 | **87.90** |
| win 6, budget 8000, trusted `__none__` | 88.90 | 88.93 | 85.60 | 87.23 |

**Rejected**, and kept behind a default-off flag rather than deleted, because
the reasoning is still sound and the answer may change as the library grows. The
mechanism for the reversal is the flip side of the original argument: `__none__`
has to cover *everything that is not an annotated song*, and the unannotated
time in incomplete files supplies a large share of that variety. Removing it
buys a cleaner negative class at the cost of a narrower one, and at an adequate
budget the narrowing costs more.

The transferable lesson: **a change that redistributes a fixed budget has to be
measured against a sweep of that budget.** This one improved every headline
number simultaneously, which normally reads as a safe accept.

### 2c. Silence-blocked anchor linking (accepted)

The anchor decoder fills any window whose evidence is weak, and a window of dead
air always has weak evidence. So one recognisable phrase could claim the silence
after it and continue into whatever followed. Silence is not ambiguous evidence
that the song continues; it is evidence that nothing is being played.

Refusing to link through a window whose `silence_ratio` reaches a threshold:

| threshold | acc | recall | precision | F1 |
| --- | --- | --- | --- | --- |
| off | 85.17 | 85.87 | 85.52 | 85.69 |
| 0.9 | 85.17 | 85.86 | 85.93 | 85.89 |
| **0.7** | 85.05 | 85.73 | 86.37 | **86.05** |
| 0.5 | 83.07 | 83.77 | 87.43 | 85.56 |

Precision rises with recall essentially untouched, which is what a correct
boundary rule looks like, and it improves the mixed metric too (68.68 -> 68.98).

Unlike the `__none__` change, it holds at the larger prototype budget — it
touches the decoder, not the budget, so there is nothing for a budget sweep to
confound:

| | acc | recall | precision | F1 |
| --- | --- | --- | --- | --- |
| win 6, budget 8000 | 89.32 | 89.48 | 86.38 | 87.90 |
| win 6, budget 8000, silence < 0.7 | 89.29 | 89.48 | 86.86 | **88.15** |

### 2d. Prototype budget (the largest single lever)

`prototypeBudget` had not been swept since v2.6 raised it from 1200 to 2000, for
a library less than half the current size. At window 5, z-scored:

| budget | acc | recall | precision | F1 |
| --- | --- | --- | --- | --- |
| 1000 | 78.55 | 79.28 | 84.76 | 81.93 |
| 2000 (the old default) | 85.17 | 85.87 | 85.52 | 85.69 |
| 4000 | 87.65 | 87.98 | 85.66 | 86.81 |
| 8000 | 88.39 | 88.57 | 86.13 | **87.33** |

Precision rises along with recall, so this is not a coverage-for-accuracy trade.

**The tail, measured on the accepted v2.10 configuration** (window 6, silence
rule on), to check that 8000 is not simply where the earlier sweep stopped:

| budget | acc | recall | precision | F1 | prototypes | fold time |
| --- | --- | --- | --- | --- | --- | --- |
| **8000** (the default) | 89.29 | 89.48 | 86.86 | **88.15** | 7,092 | 161s |
| 12000 | 90.30 | 90.50 | 85.92 | 88.15 | 10,608 | 284s |
| 16000 | 90.47 | 90.56 | 86.16 | 88.30 | 14,114 | 386s |
| 24000 | 90.37 | 90.46 | 85.90 | 88.12 | 21,006 | 740s |

**8000 is the knee.** Below it the increments are +3.76, +1.12, +0.52; above it
the curve is flat, wobbling within ±0.15 while recall keeps creeping up and
precision drifts down to cancel it. 16000 buys +0.15 F1 for double the
prototypes and 2.4x the scoring time, and 24000 is slightly *worse* than the
default. Wall time grows faster than the prototype count (cache pressure), so
the cost side is worse than the linear estimate. Question closed: leave it at
8000.

Higher budgets do shift the operating point rather than doing nothing — 16000
is +1.1 recall and −0.7 precision against 8000 — so the knob is worth
remembering if the review workflow ever wants recall over precision.
It also relieves the under-annotated-song defect from the side the three failed
corrections in the v2.3 entry did not try: at budget 2000 the smallest song got
4 prototypes, at 8000 it gets 24. Nothing about the *relative* allocation
changed — that bias is still there — but every label now has enough prototypes
to describe itself.

The cost is linear: prediction compares each window against every prototype, so
a 4x budget is a 4x scoring cost, and the model file grows from 2.0 MB to 8.3 MB.
For a local app scoring one file at a time, that is a few seconds.

## 3. Rejected

| idea | result | why |
| --- | --- | --- |
| Score-sequence smoothing (widths 3–25) | F1 85.35 / 84.45 / 81.02 / 74.90 / 69.22 | Integrating evidence over a longer horizon without adding dimensions does raise window accuracy (85.17 -> 89.11 at width 5) but blurs boundaries faster than it gains, and collapses past width 9. It is a slower, worse version of lengthening the window. |
| Feature-group weighting (chroma vs register vs activity vs style) | best 85.74 vs 85.69 | Down-weighting the six performance-style features (velocity/duration/polyphony spread, regularity) by half is within noise; ablating them entirely costs 1.2 pt. Practice-state features are not the noise source the tempo ablation suggested they would be. |
| Relaxed anchor margin (0.10, 0.12) | 82.73 / 85.27 | Reproduces the earlier conclusion on the honest metric. 0.15 is the optimum; 0.18 and 0.22 are also worse. |
| `minAnchorRun` 2, 4, 6 | 85.16 / 84.96 / 80.41 | 3 is the optimum. 6 reaches 90.04% precision at 72.65% recall, if a precision-first mode is ever wanted. |
| `minSegmentSec` 12, 16 | 85.49 / 85.06 | Human-rejected predictions did average 33s against 87s for accepted ones, but raising the floor removes correct short segments at the same rate. |
| `maxNonePrototypes` 120, 240 | 84.96 / 83.46 | 60 stands; 30 is within noise of it (85.95). |

## 4. Where the remaining error is

With the accepted changes, on complete files, about 10.5% of annotated time is
still missed. Two structural pieces of it are not model defects:

- **1.9% of annotated time is unrecoverable under LOO.** Ten songs have every
  annotation inside a single file, so leaving that file out leaves the song with
  no training support at all: Sleigh Ride (762s), Beethoven's 5th (286s), It's
  Beginning to Look a Lot Like Christmas (243s), and seven more. Their LOO
  recall is 0% by construction, and the deployed model does not have this
  problem.
- **The long tail is thin.** 20 of 63 songs appear in two files or fewer, and
  per-song recall tracks that closely. Of the songs with 60s or more annotated,
  seven sit at 0% and every one of them is a single-file song. The lowest
  non-structural cases are Santa Claus is Coming to Town (19.9%, 1,269s),
  O Come All Ye Faithful (27.5%), Ashokan Farewell (41.1%, 1,117s — many
  annotations but very low note density), Let It Snow (45.2%) and Jingle Bells
  (46.1%). Everything well represented is near ceiling: Moonlight Sonata 99.7%,
  Bink's Waltz 99.2%, Bridge Over Troubled Water 99.2%, The Entertainer 98.9%.
  `bySongSegment` in the eval report is the live list.

The highest-value next move is annotation, not architecture: a second file for
each of the ten single-file songs, and more coverage of the low-recall sparse
pieces. `trainingSummary.underAnnotatedLabels` already lists the candidates.

Second: marking a file complete is what moves it into the honest evaluation
population. 40 of 111 annotated files are still outside it, and the aggregate
row's precision is dominated by exactly those files.
