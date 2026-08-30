# ML Workflow: MIDI Song Segmentation

This folder contains the local model used by JamCoda to predict song segments inside practice-session MIDI files.

Goal:
- Input: one MIDI file
- Output: `(song_name, start_time, end_time, confidence)` segments
- Review path: predictions land in `prediction_reviews` and are triaged in the UI

## Model Summary

Current model is a lightweight KNN segmenter (`knn-song-segmenter`):
- extracts windowed MIDI features (pitch-class profile, onset density, pitch/velocity/duration/polyphony stats)
- predicts a song label per window
- smooths labels across neighboring windows
- merges windows into segments with confidence thresholds

This is intentionally simple so you can retrain often as annotations grow.

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
  --none-ratio 1.5
```

Notes:
- `--window` and `--step` are seconds.
- `--none-ratio` controls negative sampling volume.
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
- `--min-window-confidence` and `--smoothing` to compare threshold variants
- `--quiet` reduces per-file logs

## UI-Driven ML Actions

You do not need terminal commands for routine iteration:
- `Run Predictions` button on file detail page calls `POST /api/prediction-reviews/run`
- `Rebuild Model` button in sidebar calls `POST /api/prediction-reviews/rebuild-model`

Run endpoint defaults:
- `minWindowConfidence = 0.45`
- `smoothingWindows = 5`
- `minSegmentSec = 8`
- `minSegmentConfidence = 0.65`
- `mergeGapSec = 3`
- `clearUnpromoted = true`

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

- `ml/songSegmentation.ts`: feature extraction, training, prediction, smoothing, segmentation
- `ml/train.ts`: CLI training entrypoint
- `ml/predict.ts`: CLI prediction entrypoint
- `ml/predictAndImport.ts`: CLI prediction + DB import entrypoint
- `server/scripts/migrate.ts`: DB migration entrypoint
- `server/routes/predictionReviews.routes.ts`: API workflow glue
- `server/models/PredictionReview.ts`: merge/promote/status semantics
