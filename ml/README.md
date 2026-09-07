# ML Workflow: MIDI Song Segmentation

> Model changes are tracked in [`ml/CHANGELOG.md`](CHANGELOG.md).

This folder contains the local model used by JamCoda to predict song segments inside practice-session MIDI files.

Goal:
- Input: one MIDI file
- Output: `(song_name, start_time, end_time, confidence)` segments
- Review path: predictions land in `prediction_reviews` and are triaged in the UI

## Model Summary

Current model is a lightweight prototype-based segmenter (`knn-song-segmenter` v2,
release stamp `v2.11`):

- extracts windowed MIDI features (split-register pitch-class profiles —
  chroma separated into low and high register at `registerDivide`, default
  middle C, with notes extended acoustically under CC 64 damper pedal up to 0.7s
  with 0.5x decayed tail weight and weighted by sqrt(velocity/127) for melodic prominence — plus
  onset density, pitch/velocity/duration/polyphony stats, register balance,
  rhythmic regularity, silence ratio and register span)
- condenses training windows into per-label prototypes instead of retaining every
  window, so retraining and prediction stay fast and the model file stays small.
  The budget matters more than it looks: leave-one-out segment F1 on complete
  files runs 81.9% / 85.7% / 86.8% / 87.3% at budgets of 1000 / 2000 / 4000 /
  8000 — the largest single lever measured so far. It flattens there: 12000,
  16000 and 24000 all land within ±0.15 of 8000 while costing up to 4.6x the
  scoring time, so 8000 is the knee rather than a stopping point
- draws `__none__` training windows from every annotated file. Restricting them
  to files marked complete (`--trusted-none`) is a sound idea that measures as a
  win only when the prototype budget is too small — see the v2.10 entry in
  [`CHANGELOG.md`](CHANGELOG.md) before enabling it
- scores each window by its nearest prototype per song (z-scored features). Prototype budgets scale with sqrt(support), so a song with more
  annotation keeps more prototypes.
  **Known defect:** a nearest-prototype distance decreases as a song gains
  prototypes, so well-annotated songs win comparisons they must lose. Three
  corrections failed. Read the v2.3 entry in [`CHANGELOG.md`](CHANGELOG.md)
  before you try a fourth. `trainingSummary.underAnnotatedLabels` lists the
  songs below the average budget. Annotate those songs more.
- decodes windows into contiguous song spans with an **anchor-and-link** two-pass decoder:
  1. finds *anchor* runs — windows whose top song beats the runner-up by a clear margin (the recognizable phrases of a song)
  2. links those anchors together across intervening low-confidence windows
     (vamping, left-hand-only passages), stopping at a strong anchor of a
     different song, at genuine silence, or at a window whose `silence_ratio`
     reaches `linkMaxSilenceRatio`. That last rule exists because dead air
     always has a low margin, and a low margin is exactly what makes a window
     fillable, so without it one recognisable phrase could claim the silence
     after it and carry on into whatever followed
  3. bounds that linking on the right with **bridge** linking (the default since
     v2.11): a span is linked freely only when an anchor run of the *same* song
     closes it, an unvouched tail runs `linkTailSec` and then only while the song
     is still the model's own top choice, competing tails advance in lockstep,
     and a rescue pass hands a leftover span to a neighbour whose mean rank
     across it is at most `linkRescueRank`. Without it the earlier song owns
     every ambiguous window until the next one anchors, and a finished take ran a
     median 5.85s long
- converts window runs into segments. Boundaries come from window **centres**,
  because a window label applies at its centre. Training uses the same rule.
- filters and merges the segments with confidence and duration limits

This is intentionally simple so you can retrain often as annotations grow. The
anchor-and-link structure matches how practice sessions sound: distinctive
phrases are easy to identify, while the generic passages between them connect
into the surrounding song.

## Data Sources

Training pulls from:
- `data/jamcoda.db`
- `annotations` joined to `files.local_path`
- local MIDI files under `data/midi/...`

Prediction review/promotion uses:
- `prediction_reviews` table
- optional promotion into `annotations`

## Commands

Run from repo root.

### 1) Ensure schema

```bash
npm run db:migrate
```

This applies DB schema migrations (including `prediction_reviews`).

### 2) Train model

```bash
npm run ml:train -- --out data/ml/model.json
```

Common options:

```bash
npm run ml:train -- \
  --db data/jamcoda.db \
  --root . \
  --out data/ml/model.json \
  --window 6 \
  --step 1 \
  --k 7 \
  --none-ratio 1.5 \
  --prototype-budget 8000 \
  --max-none-prototypes 60 \
  --scaling zscore \
  --score-mode min \
  --decoder anchor \
  --anchor-margin 0.15 \
  --min-anchor-run 3 \
  --fill-topk -1 \
  --link-max-silence 0.7 \
  --link-policy bridge \
  --link-tail-sec 2 \
  --link-rescue-rank 5
```

Notes:
- `--window` and `--step` are seconds.
- `--register-divide` sets the MIDI note that separates low/high register
  chroma (default 60, middle C). The model stores it, so prediction uses the
  trained divide.
- `--hand-mask-augment` trains one-hand copies of song windows (fraction of
  annotated windows, default 0/off). It is a measured regression at 0.15 and
  0.5 — see `ml/CHANGELOG.md` v2.4 — and is kept behind the flag only for
  experimentation.
- `--none-ratio` controls negative sampling volume.
- `--prototype-budget` caps the total condensed prototypes across all songs;
  `--max-none-prototypes` caps the `__none__` share of that budget. Raising the
  total budget is the cheapest accuracy win available and the default was too
  low for the current library; prediction cost scales linearly with it.
- `--trusted-none` restricts `__none__` training windows to files marked
  complete. Off by default: measured as a regression at the default prototype
  budget. See the model summary above.
- `--link-max-silence` sets the `silence_ratio` at which a window stops being
  linkable into an anchor run (default 0.7; 1 disables the rule).
- `--link-policy` is `bridge` by default, which stops a finished song running
  into the next one; `--link-policy legacy` builds the pre-v2.11 model.
  `--link-tail-sec` (default 2) and `--link-rescue-rank` (default 5, `-1` off)
  tune it and are only read under `bridge`. A model trained with the policy
  records all three, so the CLI, the import pipeline and the API all decode it
  the same way. **The decoder reads an *absent* policy as `legacy`**, so a model
  saved before 2026-09-07 keeps decoding the way it was built — a default must
  never move an existing model.
- `--link-rescue-lookahead <seconds>` is experimental and off (0). It makes the
  rescue pass creep in from each end of a span while a *local* mean rank holds,
  instead of testing the whole span at once. It recognizes more takes and places
  endings better, at the cost of starts, and is a wash on F1 — see the 2026-09-07
  entry in [`CHANGELOG.md`](CHANGELOG.md).
- `--scaling` is the per-feature normalization (`minmax`, `zscore`, or `none`).
- `--score-neighbors` is the number of nearest prototypes to average per label
  (default 1, the single nearest). The fit clamps this value to the smallest
  per-label prototype count, so each label uses the same number of neighbours.
- `--decoder` is `anchor` (default, two-pass anchor-and-link), `viterbi`, or
  `smooth`. `--anchor-margin` and `--min-anchor-run` tune how easily anchor
  runs form; `--fill-topk -1` links across all windows (a positive value
  requires the linked song to be a top-K scorer in each linked window).
- At least 2 annotated files are required.
- Default behavior includes leave-one-file-out evaluation; use `--skip-eval` to disable.

### 3) Predict one file (no DB write)

```bash
npm run ml:predict -- \
  --model data/ml/model.json \
  --midi data/midi/2025-01-01/Jmx-A00001-Jan-01-2025.mid
```

Optional JSON output:

```bash
npm run ml:predict -- \
  --model data/ml/model.json \
  --midi data/midi/2025-01-01/Jmx-A00001-Jan-01-2025.mid \
  --out data/ml/predictions/latest.json
```

### 4) Predict + import to review queue

```bash
npm run ml:predict-import -- \
  --model data/ml/model.json \
  --midi data/midi/2025-01-01/Jmx-A00001-Jan-01-2025.mid
```

Useful flags:
- `--out <path>`: also save JSON payload
- `--clear-unpromoted false`: keep existing unpromoted rows
- `--dry-run`: no DB writes
- `--db <path>` and `--root <path>` for non-default layouts

After import, open:
- `#/detail/<id>` and use the `Predictions to Review` section below the piano roll

To catch up every incomplete file that has no predictions yet (e.g. right after a
sync), run the batch form:

```bash
npm run ml:predict-missing -- [--force] [--limit <n>] [--dry-run]
```

It only touches files that are incomplete and non-empty and have zero
`prediction_reviews` rows; `--force` also re-runs files that already have
predictions (clearing their unpromoted rows first). Files marked complete are
never touched.

### 5) Run evals against existing annotations

This evaluates model window predictions against your current annotation truth and writes a JSON report.
It does not write prediction rows to the DB.

```bash
npm run ml:eval
```

Useful flags:
- `--mode <loo|insample>` (default: `loo`, recommended for generalization)
- `--include-none` evaluates unlabeled (`__none__`) windows too
- `--min-window-confidence`, `--smoothing`, `--min-segment-sec`,
  `--min-segment-confidence`, and `--merge-gap-sec` to compare threshold variants
- `--quiet` reduces per-file logs
- `--out <path>` overrides the report path

Reports are named from the run's mode, the model's release stamp and a
timestamp, so runs stay referable without copying or renaming:
`data/ml/eval-loo-v2.5-20260902-143000.json`. The report JSON also records the
`modelVersion` and the model's `createdAt`. The model's release stamp is the
`modelVersion` field written at fit time (`MODEL_VERSION` in
`ml/songSegmentation.ts`); old models without it fall back to `v<architecture
version>`.

The report includes a **segment-level** comparison against your annotations:
how much of each annotated span is covered by a same-song predicted segment
(annotation recall), and how much of each predicted segment actually overlaps a
same-song annotation (segment precision), plus an F1 across both.

### Fast, comparable decoder sweeps

`ml:eval` caches each fold's label scores under `data/ml/eval-cache/`. The first
run fits and scores normally; later runs with the same data and scoring config
reuse those scores. MIDI feature extraction, decoding, note snapping and metrics
still run. Use `--cache-dir <path>` for a separate cache or `--no-cache` for a
fresh runtime measurement. The cache is disposable and never updates annotations,
prediction reviews, or the saved model.

The cache key includes annotation ranges and names, file completion, MIDI byte
hashes, training/scoring settings, and source hashes. LOO caches cover the entire
training population, not just the held-out file, and keep each fold's own label
list. In-sample caches also pin the model bytes. A prototype budget, feature,
normalization or training-data change therefore recomputes the scores. Decoder
and segment-filter overrides can reuse them:

```bash
npm run ml:eval -- --out data/ml/baseline.json
npm run ml:eval -- --anchor-margin 0.18 --out data/ml/margin18.json
npm run ml:eval -- --anchor-gap-policy evidence --out data/ml/gap-evidence.json
```

Reports contain `dataset.sha256`, a content manifest, the full effective training
config, model/source hashes, cache hit counts, and stage timings. **Only compare
variants with the same dataset hash.** For ongoing annotation work, use a SQLite
backup as `--db <snapshot>` for every run; a raw copy of a live WAL-mode database
can miss committed annotations. `--expect-dataset <sha256>` refuses a run if the
input changed, and evaluation checks again before writing the report. A model
version or annotation count alone is not a dataset identity.

`boundaryComplete` reports start/end signed error (positive = late), absolute
error, p90 absolute error, and fractions within 2 seconds or more than 2 seconds
early/late. It uses mutual best same-song overlap matches with IoU >= 0.5; missed
takes and excess fragments appear in the unmatched counts. `boundaryMatchesComplete`
keeps individual errors for paired comparisons. A lower error among fewer matched
takes is not automatically an improvement: compare overlap F1, matched coverage,
and the same matched annotations across variants.

`--link-policy legacy|bridge` overrides the linking rule without retraining, so
a bridge model can be scored as if it were legacy and vice versa. `bridge` is the
default a model is now built with; `legacy` reproduces any report written before
2026-09-07. Over 103 complete files it is worth **+2.167 F1, bootstrap 95%
[+1.403, +3.084]**, with the median ending error down from +5.85s to +0.81s and
four more takes recognized. It costs nothing in recall on this population and
does not fix repeated takes of the same song, which are now the dominant error.
See the 2026-09-07 and 2026-09-06 entries in [`CHANGELOG.md`](CHANGELOG.md), and
`experiments-2026-09-06-linking.md` under the gitignored `data/ml/notes/` for the
original method, the held-out check and the rejected alternatives.

`--link-rescue-lookahead <seconds>` is an experimental, eval-only override, off
at 0. The rescue pass normally judges an unlabelled span by its mean rank as a
whole; a lookahead makes each end creep inwards while its own local mean holds,
so a song keeps the part of a span its evidence covers. It fixes the specific
files where a take's weak middle gets truncated, and is a wash overall
(+0.020 F1, 95% [-0.526, +0.403]) — better endings and more matched takes for
worse starts. Read the 2026-09-07 entry before turning it on.

`--anchor-gap-policy legacy|midpoint|evidence` is an **experimental**, eval-only
override. Legacy is the existing behavior: the earlier anchor claims ambiguous
windows first. The other policies divide a mutually linkable gap between two
different-song anchors at its midpoint or the best single change in their score
evidence. Silence and strong competing evidence remain barriers. These experiments
do not change the app's default decoder or the saved model. See
`experiments-2026-09-06.md`, under the gitignored `data/ml/notes/`, for
controlled results.

### Compare two runs, not two numbers

`ml:eval` scores one run. Whether a change helped is a question about two, and
an aggregate can move either because the same takes were predicted better or
because a different set of takes was recognized at all. `ml:compare` separates
those:

```bash
npm run ml:compare -- --baseline data/ml/legacy.json --variant data/ml/bridge.json
```

It refuses reports from different datasets, then reports: complete-file F1 with
a per-file bootstrap interval; how many annotations each run matched and how many
they share; start and end error over the shared annotations only, with
improved/worsened counts; and the close different-song transitions both runs
matched at both ends. `--out` writes the whole thing, including every transition,
as JSON. It reads reports only — it never opens the database or the model.

Read the interval, not just the delta. A gain whose interval crosses zero rests
on a few files.

### Read the complete-files row, not the aggregate

Segment precision is reported three ways: over files marked complete, over the
files that are not, and over everything. **Compare model variants on the
complete-files row.**

Precision only means anything where the annotations are finished. In a file you
have not finished annotating, most of the audio carries no annotation, so a
*correct* prediction there is scored as a false positive. Measured over the
current library, one and the same model scores:

| population | files | audio annotated | recall | precision | F1 |
| --- | --- | --- | --- | --- | --- |
| complete | 71 | 87.7% | 85.9% | **85.5%** | 85.7% |
| incomplete | 40 | 37.2% | 87.2% | **38.0%** | 53.0% |
| all | 111 | 57.0% | 86.4% | 57.0% | 68.7% |

Recall is within 1.4 pt across the two populations — the classification problem
is equally hard in both — while precision differs by 47 points. The review queue
agrees with the complete-files number and not the aggregate: of the predictions
that have a human verdict, 85.5% by duration were confirmed or edited rather
than marked invalid.

The practical consequence is that the aggregate row barely responds to real
changes. Across window lengths 4s to 8s it moves less than a point and
non-monotonically, while the complete-files row moves 3.3 points. Precision lost
on incomplete files cancels recall gained. See
`experiments-2026-09-03-addendum.md`, under the gitignored `data/ml/notes/`.

Marking a file complete therefore does two things: it puts the file into the
honest evaluation population, and it makes the file's unannotated time usable as
`__none__` training material.

## UI-Driven ML Actions

You do not need terminal commands for routine iteration:
- `Run Predictions` button on file detail page calls `POST /api/prediction-reviews/run`
- `Rebuild Model` button in sidebar calls `POST /api/prediction-reviews/rebuild-model`
- `Rebuild Model` also re-scores predictions automatically: after saving the new
  model it re-runs predictions over every file whose unpromoted review queue is
  entirely `unsure` (nothing reviewed yet), so old predictions are replaced
  with the new model's output. Files with any confirmed/edited/invalid rows are
  left untouched, and per-file failures (e.g. a missing MIDI file) are reported
  in `reRunErrors` without failing the rebuild. This is opt-in and off by
  default (it can take a long time): the sidebar shows a "Re-score pending
  predictions" checkbox, or pass `reRunUnsure: true` to the endpoint.
- Under the piano roll on every file, a **whole-recording overview** draws the
  annotations, the current predictions and any previewed Prediction Lab
  candidates as one bar each on a shared time axis, with the playhead marked
  across all of them. It is the counterpart to the piano roll's scrolling note
  view: the shape of a session at a glance, one click to jump to any song, and —
  with a candidate up there — a direct read on where a setting change moves a
  boundary relative to what is playing.
  Candidate runs are owned by the detail page rather than the lab, which is what
  lets both draw them. The playhead is a sibling overlay, never a prop of the
  memoised `SpanRow`: `currentTime` changes every frame, and threading it into
  the rows would re-render every span in the file per frame — the mistake
  `PianoRollTimelines` is written to avoid.
- The **Prediction Lab** on a file's detail page tries prediction settings on
  that one recording. Preview runs the pipeline with `dryRun`, so nothing
  reaches `prediction_reviews` until "Apply"; candidates are held in the page
  and disappear when you leave it. Settings are split into *segment shaping*
  (post-decode filters) and *decoding* — the decoding fields re-decode the same
  trained model, so two candidates that differ only there came from one model
  and are directly comparable. Because a preview writes nothing it is also
  allowed on a file marked complete, which a committed run is not: that is the
  only place a prediction can be held against a known answer. On such a file the
  lab shows the model's segments *before* annotated time is subtracted, since
  otherwise a fully annotated file leaves nothing to look at.
  The "Current review queue" row is *stored* output, which can predate the model
  on disk — comparing a candidate against it mixes a model change with a settings
  change. Once a preview has reported which model it used, a mismatch is called
  out; for a like-for-like baseline, preview once with `Link policy: legacy`.
  **One recording forms a hypothesis; it does not settle one.** Confirm a
  setting across the library with `ml:eval` and `ml:compare` before it changes
  how models are built. Every field carries a `?` with a plain-language note on
  what it does and which way to move it, including which fields the default
  anchor decoder ignores outright; the copy lives in
  `src/components/files/predictionSettingHelp.ts`.
- `POST /api/prediction-reviews/run` accepts `dryRun` and `decoderOverrides` in
  addition to the segment filters. `decoderOverrides` takes only decode-only
  fields (`DECODE_ONLY_CONFIG_KEYS`); anything else is dropped, so a preview can
  never show segments from a model that was never built.
- `POST /api/prediction-reviews/rebuild-model` accepts the same training knobs
  as `ml:train`, including `linkPolicy`, `linkTailSec` and `linkRescueRank`.
  Anything the request omits is left undefined so `resolveTrainConfig` supplies
  it, which is what keeps the button and the CLI building the same model. The
  sidebar sends none of them, so the button trains whatever `resolveTrainConfig`
  defaults to — a `bridge` model since v2.11.
- The sidebar `Rebuild Model` button shows a badge when annotations have changed
  since the last build: the count of annotations created or edited after the
  model's `createdAt`, plus any song names the model has never seen, from
  `GET /api/prediction-reviews/rebuild-status`. It is a hint only — rebuilding
  is always a manual action, and the badge clears after a rebuild.

## Device Passage Bookmarks and Silence Gaps

Jamcorder writes two kinds of boundary hints into every recording:

- **`jmxBookmark`** — a user-triggered passage marker (pedal/button). Explicit,
  but rare in practice (typically only a couple of files in a library carry any)
  and carries no song name.
- **`jmxSkip`** — wall-clock silence compressed out of the MIDI timeline (the
  device pauses MIDI recording after ~3s of no notes). Present in the vast
  majority of recordings. Durations range from ~3s up to hours.

Neither has a song name (the JMX format has no section-naming feature).

How the app uses them:
- Parsed at sync and stored on `files.bookmarks_json` and `files.skips_json`
  (positions are playback seconds, matching annotation coordinates).
- The prediction pipeline splits predicted segments at each bookmark and at
  silence gaps >= `minSkipSplitSec` (default 30s), so a device passage or a
  long pause becomes its own reviewable segment instead of being merged across.
- After a sync, newly imported files **with bookmarks** get predictions
  auto-run (only if a model exists). Files marked complete are skipped.
- The detail-page piano roll renders bookmarks as solid green circles and
  skips >= 8s as green rings, so they're visible while annotating.
- Both are hints, not truth: they are noisy (a 3-5s pause can happen inside one
  song) and a rapid song change can have no marker. See `API_NOTES.md` for the
  full findings.
- Backfill older files: `npm run db:backfill-bookmarks`.

Run endpoint defaults:
- `minWindowConfidence = 0.45` *(ignored by the `anchor` decoder -- see below)*
- `smoothingWindows = 5` *(ignored by the `anchor` and `viterbi` decoders)*
- `minSegmentSec = 8`
- `minSegmentConfidence = 0.3`
- `mergeGapSec = 5`
- `clearUnpromoted = true`

`minSegmentConfidence` is calibrated to the anchor-link confidence scale, which
differs from the old kNN confidence (0.65). The displayed segment confidence
reflects how strongly the segment was anchored rather than a per-window softmax.

**Options that a decoder ignores.** The `anchor` decoder uses evidence margins,
so it ignores `minWindowConfidence` and `smoothingWindows`. To tune it, use
`--anchor-margin` and `--min-anchor-run`. The `viterbi` decoder ignores
`smoothingWindows`. `ml:predict` and `ml:eval` print the options that the loaded
model ignores. `decoderIgnoredOptions()` holds this mapping.

**Known defect in the confidence scale.** An anchor window keeps its raw margin,
usually 0.15 to 0.3. A linked window gets the `linkConfidence` value, 0.5.
`minSegmentConfidence` can therefore discard a segment of strong anchors and keep
a segment of mostly linked windows. One shared scale decreased accuracy (v2.3 in
[`CHANGELOG.md`](CHANGELOG.md)). A test records the current behaviour.

Prediction output is post-filtered against:
- existing `annotations` for the target file

## Review States and Promotion

`prediction_reviews.status` values:
- `unsure`: unreviewed queue item (the only status that still "needs review")
- `invalid`: rejected prediction or merged-away source segment -- settled, like
  `confirmed`/`edited`, and therefore excluded from the review queue. Still
  visible under "All Unpromoted" so rejections and merge history stay inspectable.
- `confirmed`: accepted as-is
- `edited`: accepted with corrected song and/or time bounds

Promotion rules:
- only `confirmed` and `edited` can promote
- promotion creates/updates an annotation and links `promoted_annotation_id`

Merge behavior (`POST /api/prediction-reviews/merge`):
- requires >=2 consecutive visible queue rows
- same file and same resolved song required
- creates one new merged `edited` review
- marks replaced source rows as `invalid`

## Suggested Human Workflow (Active Learning Loop)

1. Sync files.
2. Annotate a few strong examples per song.
3. Rebuild model.
4. Run predictions on target files.
5. In review queue:
- confirm high-confidence correct segments
- edit borderline segments (song or boundaries)
- mark false positives invalid
- merge fragmented adjacent segments when appropriate
6. Promote reviewed predictions.
7. Repeat.

Practical heuristics for practice-session data:
- Prefer `Edit + Promote` over `Invalid` if the predicted song is right but boundaries are off.
- Use `Invalid` for wrong song/false-positive segments.
- If a short segment is correct but clearly part of longer surrounding same-song context, merge it.
- Keep song naming consistent; rename globally when needed.
- Do not stretch one annotation across long silence; split into separate played spans.
- Mark file complete when remaining time is intentionally unlabeled improvisation/noodling.

## Tuning Short vs Long Segment Bias

There is a real tradeoff here: short matches can be useful, but songs rarely last under ~30s in a typical practice session.

Ways to balance this:
- keep `minSegmentSec` moderately high (for example 10-20s) for default runs
- keep `mergeGapSec` nonzero so nearby same-song segments collapse
- still allow short segments when confidence is high and context supports merge
- rely on review merge tool to repair over-fragmented predictions

## Troubleshooting

### `no such table: prediction_reviews`
Run:

```bash
npm run db:migrate
```

### `ml:predict` outputs segments but UI shows none
`ml:predict` does not write to DB. Use one of:
- `Run Predictions` in detail page
- `npm run ml:predict-import -- --midi <path>`

### Predictions blocked for a file
If file is marked complete, `/api/prediction-reviews/run` is blocked until you mark it incomplete.

### Missing recent songs in `model.json`
Rebuild model after new annotations using sidebar `Rebuild Model` or `npm run ml:train`.

## Key Files (for Coding Agents)

Experiment write-ups are **not** in the repo. Each dated `experiments-*.md` lives
under `data/ml/notes/`, which is gitignored along with the reports and model
snapshots it cites. `CHANGELOG.md` is the committed record and stands on its own;
the notes are the long-form working detail behind each entry. A changelog entry
naming a file you do not have is expected, not a broken link.

- `ml/songSegmentation.ts`: feature extraction, prototype training, anchor-link decoding, segmentation
- `ml/songSegmentation.test.ts`: co-located tests for feature extraction, prototype training, and decoding
- `ml/prototypeScorer.ts`: packed nearest-prototype scoring for the default `min`/single-neighbour mode
- `ml/evalCache.ts`: dataset/config/source fingerprints and the persistent per-fold score cache
- `ml/boundaryEvaluation.ts`: take-level boundary matching and signed start/end error
- `ml/evalComparison.ts` + `ml/compareEvals.ts`: paired comparison of two eval reports (`ml:compare`)
- `ml/train.ts`: CLI training entrypoint
- `ml/predict.ts`: CLI prediction entrypoint (model only, no DB writes)
- `ml/predictAndImport.ts`: CLI wrapper around the shared import pipeline
- `src/components/files/FileOverview.tsx`: whole-recording span bars and playhead, shared by the detail page and the lab
- `src/components/files/predictionCandidates.ts`: the previewed-run shape both of them draw
- `src/components/files/PredictionLab.tsx`: per-file settings preview and candidate comparison
- `src/components/files/predictionSettingHelp.ts`: the `?` copy for every lab setting
- `server/services/predictionImport.ts`: the prediction + import pipeline itself,
  shared with `POST /api/prediction-reviews/run` so the CLI and the API cannot
  drift. Schema is the migration runner's job; nothing here creates tables.
- `core/timeRanges.ts`: annotated range exclusion
- `core/cli/args.ts`: shared CLI argument parsing
- `server/scripts/migrate.ts`: DB migration entrypoint
- `server/routes/predictionReviews.routes.ts`: API workflow glue
- `server/models/PredictionReview.ts`: merge/promote/status semantics
