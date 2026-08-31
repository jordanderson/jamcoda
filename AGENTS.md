# AGENTS.md

Agent runbook for `jamcoda`.

## Purpose

Use this file for repo-specific execution guidance. For product and ML details, read:
- `README.md`
- `ml/README.md`

## Read First

`core/` holds everything shared across tiers -- read it before changing
behaviour that exists on more than one side of a boundary:
- `core/types.ts`, `core/predictionReview.ts`, `core/timeRanges.ts`
- `core/midi/noteSequence.ts`, `core/cli/args.ts`

Then:
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

Use Node 22 (`.nvmrc`, and `engines.node` is `>=22`). Run `nvm use` first if you
manage versions with nvm -- see the native-module note under Change Hygiene
before running `npm install` on a different version.

- Install: `npm install`
- Dev: `npm run dev`
- Build: `npm run build`
- DB migrate: `npm run db:migrate`
- Typecheck (client + server/ml + tooling): `npm run typecheck`
- Test (server + client/core): `npm test`
- ML train: `npm run ml:train -- --out data/ml/model.json`
- Predict only: `npm run ml:predict -- --model data/ml/model.json --midi <path>`
- Predict + import: `npm run ml:predict-import -- --model data/ml/model.json --midi <path>`

## Architecture Snapshot

- Shared: `core/` -- pure, isomorphic domain code with no I/O. It is typechecked
  against both the DOM and Node libs (it appears in `tsconfig.json` *and*
  `tsconfig.server.json`), which is what keeps it safe for both. `core/cli/` is
  the one deliberately Node-only corner.
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
- A review resolves to its `reviewed_*` values only when its status is `edited`;
  every other status uses `predicted_*`. This rule lives once, in
  `core/predictionReview.ts` -- both `resolveReviewFields()` and the
  `RESOLVED_*_SQL` fragments. Do not re-express it inline or with a bare
  `COALESCE`, which is how the SQL and TS paths previously disagreed.
- The prediction pipeline has one implementation,
  `server/services/predictionImport.ts`. The API route and `ml:predict-import`
  both call it; neither reimplements exclusion, inserts, or schema.
- Playback is normalized to grand piano (`src/audio/pianoSampler.ts` loads no
  other instrument), and soundfont cache worker stores piano assets only.
- Sync uses a cheap filesystem walk over the detailed file listing (real sizes → skip-unchanged), falls back to the library API when the walk fails, skips unchanged assets by size, and records a high-water mark so a library-API fallback is fast. `POST /api/sync/start?full=1` forces a full pass. The library API is crash-prone on low-power firmware, so it is never the primary discovery source.
- A device file that is smaller than the synced copy is skipped with a warning (device-side truncation hazard); do not overwrite local data with it.
- The Jamcorder firmware is resource-constrained and may drop requests or crash; the sync client uses small library pages, generous inter-page/inter-download delays, and per-page/per-file retries.

## Typical Workflow Changes

- New annotations or song rename should be followed by model rebuild.
- If user reports `no such table: prediction_reviews`, run `npm run db:migrate`.
- If CLI prediction output does not appear in UI, use `Run Predictions` in detail page or `ml:predict-import`.
- If predictions are over-fragmented, prefer merge and threshold tuning over manual DB edits.
- If the user needs to re-check every device file (e.g. after a device reprovision or fresh SD card), use the sidebar's "Full re-sync" button rather than editing the high-water mark.
- If the server dies at startup with `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION
  <n>. This version of Node.js requires NODE_MODULE_VERSION <m>`, the
  `better-sqlite3` native binary was built for a different Node major than the
  one now running it. Fix with `nvm use && npm rebuild better-sqlite3` -- see
  Change Hygiene.

## Test Conventions

- Tests are **co-located siblings**, not in `__tests__/` directories:
  `core/timeRanges.test.ts` sits next to `core/timeRanges.ts`. This is the
  Vitest default and what the existing suites follow.
- Scope a test file to one feature of a large module with an infix:
  `Annotation.merge.test.ts` covers merge behaviour in `Annotation.ts`.
- **Two runners, and they are not interchangeable.** Pick by directory:
  - `core/` and `src/` -> **Vitest** (`import { describe, it, expect } from 'vitest'`),
    jsdom environment, discovered by the `include` globs in `vite.config.ts`.
  - `server/` -> **Node's built-in runner** (`node:test` + `node:assert/strict`),
    because server code runs under tsx directly. Vitest globals are not
    available there.
- Shared client test helpers stay in `src/test/` (`setup.ts`, `mocks/`,
  `utils/renderWithProviders.tsx`) rather than being co-located -- they belong
  to no single module.
- A server test **must** point `JAMCODA_DB_PATH` at a temp database before
  importing any model, and import models lazily (after setting it).
  `initializeDatabase()` refuses to run with `NODE_ENV=test` against the app DB,
  so this is enforced rather than merely conventional.
- Prefer testing pure functions in `core/` over reaching through a route: that
  is why the domain rules were moved there.

## Validation Checklist

After changes, run what is relevant:
- `npm run typecheck` (covers `src/`, `core/`, `server/`, `ml/`, and tooling)
- `npm test`
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

- Run `npm install` / `npm rebuild` under Node 22 only. `better-sqlite3` is a
  native module: its compiled binary is tied to the Node ABI of whichever
  version installed it, so installing under a different major (e.g. an agent
  shell defaulting to Node 20) leaves a binary the project's own Node 22 cannot
  load, and the server dies at `initializeDatabase()` with `ERR_DLOPEN_FAILED`.
  It fails only at runtime -- typecheck, build and the client are all unaffected,
  so it is easy to miss. Recover with `nvm use && npm rebuild better-sqlite3`.
- Do not hand-edit `data/jamcoda.db` unless explicitly asked.
- Prefer API/model layer changes over ad hoc SQL in route handlers.
- Keep docs in sync when behavior/status semantics change.
