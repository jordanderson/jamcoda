# Model Changelog

Track changes to the prediction model (`ml/songSegmentation.ts`, the
`data/ml/model.json` it produces, and the CLI/API that drive it). Newest
entries go on top. For each change, record *what* changed, *why*, and how it
moved the evaluation numbers so we can judge whether a change helped.

How to read the numbers:
- **Insample** — predictions on the same files the model was trained on
  (optimistic; useful for catching regressions in the pipeline).
- **LOO** — leave-one-file-out (honest generalization to files the model has
  not seen). This is the number to watch.
- **Segment F1** — overlap between predicted segments and annotations
  (recall = annotated time covered by a same-song segment; precision =
  predicted time that overlaps a same-song annotation). This is the closest
  single number to "predictions vs annotations".
- See `ml/eval.ts` for how these are computed.

---

## 2026-08-31 — v2.3: segment boundaries, model-load guard, honest eval

### Context

A code review found four silent defects and one accuracy hypothesis. The
hypothesis failed. All numbers below are leave-one-file-out over 48 annotated
files. The failed experiments are recorded because they are expensive to repeat.

### What changed

**Segment boundaries now use window centres.** Training labels a window at its
centre: `buildSamplesForFile` calls `getLabelAtTime` at
`startTime + windowSec / 2`. But `windowsToSegments` built spans from the full
window extent. With truth `A=[20,40)` and `B=[40,55)` and correct window labels,
it produced `A=[18,41]` and `B=[38,56]`. Each segment was 3s too long, and each
adjacent pair overlapped by `windowSec - stepSec`. These segments go into
`prediction_reviews`, and then into `annotations`, so the error entered the next
training set. Centres give the correct span. A 7000s file now gives 48 segments
and 0 overlapping pairs.

**`loadModel` rejects a model with a different feature set.** The feature vector
changed from 18 to 25 entries in v2.0. An older `model.json` still loaded, then
produced NaN for every distance. Every NaN comparison is false, so the decoder
returned `__none__` for every window. The user saw 0 segments and no error.
`loadModel` now throws and names the correction.

**Leave-one-out evaluation measures the decoder that the app uses.**
`evaluateLeaveOneOut` used a per-window argmax, with no anchor seeding, no
linking and no `__none__` handling. `ml:train` and `rebuild-model` therefore
reported an accuracy for a path that no caller runs, and disagreed with
`ml:eval`. It now calls `predictWindowsFromSamples`.

**The CLIs report the options that a decoder ignores.** The `anchor` decoder
never reads `minWindowConfidence` or `smoothingWindows`. The `viterbi` decoder
never reads `smoothingWindows`. The README, `ml:predict`, `ml:eval` and the run
endpoint documented both as tuning options, and the eval report recorded them as
if they changed the result. `minWindowConfidence` at 0.0 and at 0.99 gave
identical output. `decoderIgnoredOptions()` now holds this mapping.

**Smaller changes.** The model stores the resolved `TrainConfig`, so a change to
a default does not change an existing model. `allocatePrototypeBudgets` takes
the `__none__` index instead of assuming index 0. `predictLabelIndex` is
removed: its confidence was always 0 in `min` score mode, because every score
there is negative. `trainingSummary.underAnnotatedLabels` lists songs below the
average prototype budget.

### Results

| metric | v2.2 | v2.3 | delta |
| --- | --- | --- | --- |
| window accuracy | 50.91% | 50.91% | 0.00 pt |
| segment recall | 52.48% | 51.26% | -1.22 pt |
| segment precision | 45.05% | 45.43% | +0.37 pt |
| segment F1 | 48.49% | 48.17% | -0.32 pt |
| segments emitted | 361 | 364 | +3 |
| predicted seconds | 37,652 | 36,468 | -1,184 |

**This release does not improve accuracy.** Window accuracy is identical,
because the scoring code is unchanged. Segment F1 decreases by 0.32 pt. The
pipeline is deterministic, so this is a small real decrease, not noise. 16 songs
with 60s or more of annotation still get 0% recall, the same as v2.2.

The 1184s decrease in predicted time is the boundary correction. It removes
about 3s from each of 364 segments. Some of that time covered real annotations,
which is why recall decreases more than precision increases.

The value of this release is correct output and clear error reporting, not accuracy.

### Failed experiments

Prototype budgets scale with sqrt(support). A nearest-prototype distance
decreases as a label gains prototypes, so well-annotated songs win comparisons
they must lose. In a controlled test with two labels from an identical
distribution and 120 against 25 prototypes, the larger label won 81% of the
time instead of 50%. On real data, recall followed prototype count: 53.9% for
songs with 25 or more prototypes, 33.6% for songs below that.

The bias is real. Three corrections failed:

1. **One equal budget for every label**, 54 labels at 22 prototypes. Segment F1
   fell from 48.49% to 37.40%. Window accuracy fell 2.28 pt. Mean segment length
   grew from 104s to 261s. An equal budget discards coverage that
   well-annotated songs need. An equal budget for `__none__` also stops silence
   from competing, so songs extend across it.
2. **Equal budgets for songs, `__none__` exempt.** Segment F1 37.39%. The
   `__none__` budget was not the cause; the loss of per-song coverage was. A
   higher `minSegmentConfidence` did not help: 0.45, 0.55 and 0.65 gave F1
   32.5%, 24.3% and 9.8%. Precision stayed near 30-37% at every value, so the
   segments were wrong, not under-filtered.
3. **Per-label scale calibration.** Divide each label distance by the median
   spacing of its own prototypes. This cancels the count effect in theory, and
   it corrected the controlled test from 81% to 51%. On real data it gave F1
   23.37% and window accuracy 17.18%. Spacing does not separate "few
   prototypes" from "varied class". `__none__` is a varied class, so
   calibration gave it a large advantage and it covered most of the timeline.

Conclusion: sqrt(support) budgeting works as a prior, because a well-annotated
song is both more frequent and more varied. The prototype advantage of
`__none__` works as the song/none decision threshold. A correction must fix
song-against-song comparison without changing the song/none balance and without
reducing per-song coverage. One untried option is a per-label offset calibrated
on held-out windows rather than on prototype geometry.

Two related defects were also corrected, measured, and reverted. Tests now
record both:

- **Anchor and linked windows use different confidence scales.** An anchor keeps
  its raw margin, 0.15 to 0.3. A linked window gets 0.5. `windowsToSegments`
  averages these values against `minSegmentConfidence`, so it discards a segment
  of 20 strong anchors and keeps a segment of 3 anchors and 17 linked windows.
- **The duration limit applies before the merge**, so two adjacent 5s runs of
  one song are both discarded instead of merged into one 10s segment.

Both corrections were part of experiment 1 and could not be separated from its
losses. Each needs its own measurement.

## 2026-08-31 — v2.2: silence gaps as boundary hints + piano-roll markers

### Context

Bookmarks turned out to be rare, so the device's other implicit boundary
signal — `jmxSkip` silence-compression gaps — is the one worth building on.
When the player stops for the configured threshold (3s in the common
configuration) MIDI recording pauses and a `jmxSkip` records the omitted
wall-clock duration. These are far more common.

### Findings

- **Wall-clock gaps ARE encoded**, as `jmxSkip.millis`; playback position is
  the cumulative SMF delta-tick (same coordinates as annotations).
- **The vast majority of recordings** contain skips, vs a couple with bookmarks.
- **Noisy as boundaries**: only ~13-18% of skips sit near an annotation
  boundary; ~25-30% fall inside an annotated span (within-song pauses). Bigger
  gaps are more reliable but never clean, so they are split hints, not truth.

### What changed

- `server/utils/jmxParser.ts` parses `jmxSkip` into `JmxMetadata.skips`
  (`millis`, `timeSec`, optional wall-clock anchors).
- New `files.skips_json` column (migration 005), populated at sync; the
  `db:backfill-bookmarks` script now backfills skips too.
- The prediction pipeline splits segments at each bookmark (always) and at
  silence gaps >= `minSkipSplitSec` (default 30s, configurable via
  `POST /api/prediction-reviews/run` and `--min-skip-split-sec`).
- **Piano-roll visualization** (`PianoRollVisualizer`): device bookmarks render
  as solid green circles and skips >= 8s as green rings at the top edge of the
  roll, matching the Jamcorder device's look, so the user sees device-marked
  boundaries while annotating. `GET /api/files/:id` exposes both arrays.

### Results

No accuracy delta (hints only). Two workflow wins: (1) the ~30s+ silence gaps
now keep predictions from merging across genuine pauses/sessions, and (2) the
piano roll surfaces device boundaries during annotation. The dominant failure
mode remains: most song changes have *no* large gap (rapid transitions), so the
ML model still does most of the work.

---

## 2026-08-31 — v2.1: Jamcorder passage bookmarks as boundary hints

### Context

The v2 model improved generalization but still hallucinated wrong songs in
unannotated tails, and song boundaries remained pure inference. The Jamcorder
device writes `jmxBookmark` meta events when the player triggers a passage
marker — a natural, device-provided segmentation hint. The open question was
whether the device also stores *section names*; it does not (see below).

### Findings

- **Bookmarks exist and parse cleanly.** `jmxBookmark{bookmarkIdx,
  bookmarkUuid, bookmarkSource, unixtime, localOffset}` marks the end of a
  user-selected passage. Position on the playback timeline is the cumulative
  SMF delta-tick (1 ms/tick in JMX), which is the same coordinate system the
  annotations use. Sparse in practice: only a couple of files in the
  calibration library carry any.
- **No section names anywhere.** The JMX spec has no name event, and a raw byte
  scan of recording files found no human-readable song/section-name strings.
  Bookmarks carry no names, so the device cannot supply song names.
- **Bookmarks are not reliable song boundaries.** They have been observed
  sitting in an unannotated tail rather than at annotated song changes. They
  are passage hints, not truth.

### What changed

- `server/utils/jmxParser.ts` now parses `jmxBookmark` and records each
  bookmark's playback `timeSec`.
- New `files.bookmarks_json` column (migration 004), populated at sync for new
  and re-synced files; `npm run db:backfill-bookmarks` backfills the existing
  library.
- `core/timeRanges.ts` gains `splitSegmentsAtTimes`; the prediction pipeline
  (`server/services/predictionImport.ts`) splits predicted segments at each
  bookmark, so device passages become reviewable segments instead of being
  merged across.
- After a sync, newly imported files that carry bookmarks get predictions
  auto-run (`server/services/sync.service.ts`), so the device's passages land
  in the review queue without a manual "Run Predictions" step. Conservative:
  only bookmarked files, only if a model exists, failures never break sync.
- `GET /api/files/:id` and `POST /api/prediction-reviews/run` report bookmarks
  and bookmark-split counts.

### Results

No accuracy delta (bookmarks do not change the model). The win is workflow:
device-marked passages now structure the review queue automatically. Given how
sparse bookmarks are, the signal will matter more as the player uses the
trigger regularly.

### Known limitations

- Bookmarks are rare (2 files) and not validated as song boundaries; they are
  a split hint, so a bookmark in the middle of one song produces two segments
  for the user to merge.
- Section/song names are not available from the device. Auto-annotation still
  needs the ML model to name each passage.

---

## 2026-08-31 — v2: prototype model + anchor-and-link decoding

### Context

The v1 model (classic k-NN over ~73k retained training windows) had three
problems in practice:

1. **Memorization, not prediction.** Per-window k-NN on training files scored
   ~98% F1 purely because each window's own copy sat at distance 0 in the
   training set. On unseen files generalization was poor.
2. **Fragmentation and hallucination.** Stored review queues showed songs
   split into many tiny segments and wrong songs proposed in noodling tails.
3. **Heavy.** Every prediction recomputed distances against all 73k vectors
   (eval took 13+ minutes), and the model file was 36 MB.

### What changed

- **Condensed prototype representation.** Instead of retaining every training
  window, each label keeps a small set of prototype vectors (budget scales
  with √support so rare songs still get prototypes; `__none__` gets a hard
  cap). 73,164 windows → 1,129 prototypes. Model file 36 MB → ~0.7 MB, eval
  runs in seconds.
- **Richer features (18 → 25).** Added `velocity_std`, `duration_std`,
  `polyphony_std`, `silence_ratio`, `pitch_span`, `tempo_bpm` (median
  inter-onset tempo), `regularity` (peak onset autocorrelation).
- **minmax feature scaling** instead of z-score (z-score's tiny stds were
  distorting distances).
- **`min` score mode:** each window is scored by its nearest prototype per
  label, so prototype counts do not bias the vote.
- **Anchor-and-link decoder** (replaces per-window smoothing). Pass 1 finds
  *anchor runs* — consecutive windows whose top song beats the runner-up by a
  margin ≥ 0.15. Pass 2 links anchors of the same song across the intervening
  low-confidence (vamping / left-hand-only) windows, stopping at a strong
  anchor of a different song or at genuine silence. This yields contiguous
  song spans instead of fragmented runs.
- **Confidence rescale.** Confidence is now margin-based (anchor strength);
  the `minSegmentConfidence` default dropped 0.65 → 0.3 to match.
- **Tooling:** `ml:eval` now reports segment-level recall/precision/F1 vs
  annotations; `ml:train` gained the new knobs; added
  `ml/songSegmentation.test.ts`.

### Results

| Metric (LOO, unseen files) | v1 baseline | v2 |
|---|---|---|
| Annotated-window accuracy | 37% (Feb eval, 21 files) / 51% (8-file subset) | **52.6%** (44 files) / **57.7%** (8-file subset) |
| Segment recall / precision / F1 | n/a (not measured) | 54.3% / 45.0% / **49.2%** |

Insample: window accuracy 84.9% (annotated windows), segment recall /
precision / F1 = 87.1% / 57.9% / 69.5%.

Concrete: recordings whose ground truth is a single dominant song now come
back as one contiguous, correctly-labelled span (previously they fragmented or
were mislabelled), and `ml:predict-import` fills annotation gaps with the
correct song instead of the wrong ones v1 proposed.

### Known limitations / next candidates

- LOO precision is still ~45%: on unseen files, roughly half of predicted
  song-time is wrong. The 4s window features do not separate these songs
  strongly, so human review remains necessary.
- **JMX bookmarks (TODO):** the Jamcorder JMX trailer may carry bookmark
  events at song/session boundaries. `server/utils/jmxParser.ts` currently
  parses `jmxAsset` / `jmxStoneHdr` / `jmxEof` but not bookmarks. Worth
  investigating as a boundary hint (caveats: a bookmark can split the same
  song if the player stepped away, and rapid song changes may have no
  bookmark).
- Window-level features are noisy; aggregating features over longer spans
  (e.g. a second-level "song template" classifier) is the most promising
  direction for the next LOO precision jump.

---

## Before v2 — v1 model (historical reference)

The prior model (`knn-song-segmenter`, model version 1) that shipped before
the 2026-08-31 change:

- Classic k-NN (k=7) over every training window; the full set of standardized
  windows was embedded in `data/ml/model.json` (~36 MB).
- 18 features: 12 pitch-class durations + onset density, mean pitch, pitch
  std, mean velocity, mean duration, mean polyphony, z-scored.
- Per-window label by inverse-distance k-NN vote; confidence = best vote
  share; `minWindowConfidence=0.45`, `minSegmentConfidence=0.65`.
- Post-processing: majority smoothing over 5 windows, then contiguous-run
  segmentation with length/confidence filters and gap merging.
- Documented LOO window accuracy on annotated windows: ~37% (Feb 2026 eval,
  21 files). Failure modes: false negatives (annotated song windows predicted
  as `__none__`), fragmented segments, and wrong-song predictions in
  unannotated tails.