# ML Workflow: MIDI Song Segmentation

> Model changes are tracked in [`ml/CHANGELOG.md`](CHANGELOG.md).

This folder contains the local model used by JamCoda to predict song segments inside practice-session MIDI files.

Goal:
- Input: one MIDI file
- Output: `(song_name, start_time, end_time, confidence)` segments
- Review path: predictions land in `prediction_reviews` and are triaged in the UI

## Model Summary

Current model is a lightweight prototype-based segmenter (`knn-song-segmenter` v2):

- extracts windowed MIDI features (pitch-class profile, onset density, pitch/velocity/duration/polyphony stats, plus tempo, rhythmic regularity, silence ratio and register span)
- condenses training windows into per-label prototypes (a few hundred total) instead of retaining every window, so retraining and prediction are fast and the model file stays small
- scores each window by its nearest prototype per song (minmax-scaled
  features). Prototype budgets scale with sqrt(support), so a song with more
  annotation keeps more prototypes.
  **Known defect:** a nearest-prototype distance decreases as a song gains
  prototypes, so well-annotated songs win comparisons they must lose. Three
  corrections failed. Read the v2.3 entry in [`CHANGELOG.md`](CHANGELOG.md)
  before you try a fourth. `trainingSummary.underAnnotatedLabels` lists the
  songs below the average budget. Annotate those songs more.
- decodes windows into contiguous song spans with an **anchor-and-link** two-pass decoder:
  1. finds *anchor* runs — windows whose top song beats the runner-up by a clear margin (the recognizable phrases of a song)
  2. links those anchors together across intervening low-confidence windows (vamping, left-hand-only passages), stopping at a strong anchor of a different song or at genuine silence
- converts window runs into segments. Boundaries come from window **centres**,
  because a window label applies at its centre. Training uses the same rule.
- filters and merges the segments with confidence and duration limits

This is intentionally simple so you can retrain often as annotations grow. The anchor-and-link structure mirrors how practice sessions actually sound: distinctive phrases are easy to identify, while the generic passages between them get connected into the surrounding song.

## Data Sources

Training pulls from:
- `data/jamcoda.db`
- `annotations` joined to `files.local_path`
- local MIDI files under `data/midi/...`

Prediction review/promotion uses:
- `prediction_reviews` table
- `ignored_sections` table (ranges excluded from prediction output)
- optional promotion into `annotations`

## Commands

Run from repo root.

### 1) Ensure schema

```bash
npm run db:migrate
```

This applies DB schema migrations (including `prediction_reviews` and `ignored_sections`).

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
  --window 4 \
  --step 1 \
  --k 7 \
  --none-ratio 1.5 \
  --prototype-budget 1200 \
  --max-none-prototypes 120 \
  --scaling minmax \
  --score-mode min \
  --decoder anchor \
  --anchor-margin 0.15 \
  --min-anchor-run 3 \
  --fill-topk -1
```

Notes:
- `--window` and `--step` are seconds.
- `--none-ratio` controls negative sampling volume.
- `--prototype-budget` caps the total condensed prototypes across all songs;
  `--max-none-prototypes` caps the `__none__` share of that budget.
- `--scaling` is the per-feature normalization (`minmax`, `zscore`, or `none`).
- `--score-neighbors` is the number of nearest prototypes to average per label
  (default 1, the single nearest). The fit clamps this value to the smallest
  per-label prototype count, so each label uses the same number of neighbours.
- `--decoder` is `anchor` (default, two-pass anchor-and-link), `viterbi`, or
  `smooth`. `--anchor-margin` and `--min-anchor-run` tune how easily anchor
  runs form; `--fill-topk -1` links aggressively (a positive value requires the
  linked song to be a top-K scorer in each linked window).
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
- `#/reviews?fileId=<id>`

### 5) Run evals against existing annotations

This evaluates model window predictions against your current annotation truth and writes a JSON report.
It does not write prediction rows to the DB.

```bash
npm run ml:eval -- --out data/ml/eval-report.json
```

Useful flags:
- `--mode loo` runs leave-one-file-out evaluation (recommended for generalization)
- `--include-none` evaluates unlabeled (`__none__`) windows too
- `--min-window-confidence`, `--smoothing`, `--min-segment-sec`,
  `--min-segment-confidence`, and `--merge-gap-sec` to compare threshold variants
- `--quiet` reduces per-file logs

The report now includes a **segment-level** comparison against your annotations:
how much of each annotated span is covered by a same-song predicted segment
(annotation recall), and how much of each predicted segment actually overlaps a
same-song annotation (segment precision), plus an F1 across both. This is the
closest single number to "predictions vs annotations".

## UI-Driven ML Actions

You do not need terminal commands for routine iteration:
- `Run Predictions` button on file detail page calls `POST /api/prediction-reviews/run`
- `Rebuild Model` button in sidebar calls `POST /api/prediction-reviews/rebuild-model`

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
- `mergeGapSec = 3`
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
- `ignored_sections` for the target file

## Review States and Promotion

`prediction_reviews.status` values:
- `unsure`: unreviewed queue item
- `invalid`: rejected prediction or merged-away source segment
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
- Use ignored sections for short/noisy passages you intentionally never want predicted/annotated.

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

- `ml/songSegmentation.ts`: feature extraction, prototype training, anchor-link decoding, segmentation
- `ml/songSegmentation.test.ts`: co-located tests for feature extraction, prototype training, and decoding
- `ml/train.ts`: CLI training entrypoint
- `ml/predict.ts`: CLI prediction entrypoint (model only, no DB writes)
- `ml/predictAndImport.ts`: CLI wrapper around the shared import pipeline
- `server/services/predictionImport.ts`: the prediction + import pipeline itself,
  shared with `POST /api/prediction-reviews/run` so the CLI and the API cannot
  drift. Schema is the migration runner's job; nothing here creates tables.
- `core/timeRanges.ts`: annotated/ignored range exclusion
- `core/cli/args.ts`: shared CLI argument parsing
- `server/scripts/migrate.ts`: DB migration entrypoint
- `server/routes/predictionReviews.routes.ts`: API workflow glue
- `server/models/PredictionReview.ts`: merge/promote/status semantics
