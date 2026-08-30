# AGENTS.md

Agent runbook for `jamcoda`.

## Purpose

Use this file for repo-specific execution guidance. For product and ML details, read:
- `README.md`
- `ml/README.md`

## Read First

Open these files first when starting work:
- `src/App.tsx`
- `src/components/layout/Sidebar.tsx`
- `src/components/files/DateBrowser.tsx`
- `src/components/files/DetailPage.tsx`
- `src/components/reviews/PredictionReviewPage.tsx`
- `src/components/songs/SongsPage.tsx`
- `src/hooks/useMidiPlayer.ts`
- `server/routes/files.routes.ts`
- `server/routes/annotations.routes.ts`
- `server/routes/predictionReviews.routes.ts`
- `server/models/PredictionReview.ts`
- `ml/songSegmentation.ts`

## Quick Start

- Install: `npm install`
- Dev: `npm run dev`
- Build: `npm run build`
- DB migrate: `npm run db:migrate`
- ML train: `npm run ml:train -- --out data/ml/model.json`
- Predict only: `npm run ml:predict -- --model data/ml/model.json --midi <path>`
- Predict + import: `npm run ml:predict-import -- --model data/ml/model.json --midi <path>`

## Architecture Snapshot

- Frontend: React + Vite + hash routing.
- Local backend: Express on `http://localhost:3001`.
- External device API: Jamcorder at `http://jamcorder.local` (default; override with `JAMCORDER_URL`).
- Storage (all local state lives under `data/`, which is gitignored):
  - DB: `data/jamcoda.db` (override with `JAMCODA_DB_PATH`)
  - MIDI files: `data/midi/YYYY-MM-DD/...` (override with `JAMCODA_MIDI_DIR`)
  - ML artifacts: `data/ml/`

Core frontend routes:
- `#/browse`
- `#/detail/:id`
- `#/reviews`
- `#/songs`

## Invariants To Preserve

- File completion is authoritative.
- `POST /api/prediction-reviews/run` must reject complete files.
- Marking file complete clears all `prediction_reviews` rows for that file.
- Prediction review statuses are `unsure | invalid | confirmed | edited`.
- Promotion only for `confirmed` and `edited`.
- Merge behavior:
  - selected rows must be same file and same resolved song
  - create one merged `edited` row
  - mark merged source rows `invalid`
- Song rename updates both annotations and prediction review name fields.
- Playback is normalized to grand piano (`useMidiPlayer`), and soundfont cache worker stores piano assets only.
- Sync uses a cheap filesystem walk over the detailed file listing (real sizes → skip-unchanged), falls back to the library API when the walk fails, skips unchanged assets by size, and records a high-water mark so a library-API fallback is fast. `POST /api/sync/start?full=1` forces a full pass. The library API is crash-prone on low-power firmware, so it is never the primary discovery source.
- A device file that is smaller than the synced copy is skipped with a warning (device-side truncation hazard); do not overwrite local data with it.
- The Jamcorder firmware is resource-constrained and may drop requests or crash; the sync client uses small library pages, generous inter-page/inter-download delays, and per-page/per-file retries.

## Typical Workflow Changes

- New annotations or song rename should be followed by model rebuild.
- If user reports `no such table: prediction_reviews`, run `npm run db:migrate`.
- If CLI prediction output does not appear in UI, use `Run Predictions` in detail page or `ml:predict-import`.
- If predictions are over-fragmented, prefer merge and threshold tuning over manual DB edits.
- If the user needs to re-check every device file (e.g. after a device reprovision or fresh SD card), use the sidebar's "Full re-sync" button rather than editing the high-water mark.

## Validation Checklist

After changes, run what is relevant:
- `npm run build`
- Route-level smoke checks in UI:
  - browse loads
  - detail playback and annotation actions
  - review queue actions (confirm/edit/invalid/merge/promote)
  - songs page playback modal and rename flow
- ML checks when touched:
  - rebuild model endpoint
  - run predictions endpoint
  - predict-import CLI path

## Change Hygiene

- Do not hand-edit `data/jamcoda.db` unless explicitly asked.
- Prefer API/model layer changes over ad hoc SQL in route handlers.
- Keep docs in sync when behavior/status semantics change.
