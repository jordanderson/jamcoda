# JamCoda

JamCoda is a local-first MIDI workflow for Jamcorder practice sessions.

It does four things end-to-end:
1. Sync `.mid/.midi` files from Jamcorder into local storage.
2. Let you annotate song segments with start/end times.
3. Run an ML segmentation model that proposes song segments.
4. Review, edit, merge, and promote predictions into new annotations.

This README is for both daily use and fast codebase onboarding.

## Current Product Workflow

### 1) Sync and browse
- Use `Sync Now` in the sidebar.
- Files appear in `#/browse` (Date View) with:
  - annotation progress (or `Complete`)
  - unreviewed prediction count (click count to open review queue)
  - song chips that jump to timestamps

### 2) Annotate on file detail page
- Open a file (`#/detail/:id`).
- Use piano roll playback + `S/E/C` checkpoints or manual region selection.
- Add/edit/delete annotations.
- Add ignored sections for ranges you do not plan to annotate.
- Use `Run Predictions` for that file.
- Use `Mark Complete` when remaining unannotated time is just noodling.
  - Marking complete clears all predictions for that file.
  - Complete files cannot run prediction again until marked incomplete.

### 3) Review predictions
- Open `#/reviews` or `#/reviews?fileId=<id>`.
- Review list focuses on unpromoted rows.
- API queue (`GET /api/prediction-reviews/queue`) prioritizes low-confidence and shorter segments.
- Actions:
  - `Confirm + Promote`
  - `Edit + Promote`
  - `Mark Invalid`
  - `Merge Selected` (consecutive rows, same file, same song)
  - `Promote Reviewed` (batch promote confirmed/edited)
- Review status values are currently:
  - `unsure`, `invalid`, `confirmed`, `edited`
- `ready` is intentionally removed.

### 4) Song-level operations
- Open `#/songs` for all annotated segments across files.
- Sort client-side by song or date.
- Play segment in a modal with pause/stop and seekable segment bar.
- Rename a song globally; this updates:
  - `annotations.song_name`
  - `prediction_reviews.predicted_song_name`
  - `prediction_reviews.reviewed_song_name`
- Rename flow also triggers model rebuild from the UI.

### 5) Rebuild model globally
- Sidebar has `Rebuild Model`.
- This retrains from all current annotations and writes `data/ml/model.json`.

## Routes (Frontend)

- `#/browse`: Date View (library table)
- `#/detail/:id`: file detail, piano roll, annotation tools, run predictions
- `#/reviews` (`?fileId=` optional): prediction review queue
- `#/songs`: annotated song history + rename + playback modal

## Backend API (Local Express)

The app uses `http://localhost:3001` for local state and ML actions.

### Sync
- `POST /api/sync/start`
- `GET /api/sync/progress/:syncId`
- `GET /api/sync/status`

### Files
- `GET /api/files/by-date`
- `GET /api/files/:id`
- `GET /api/files/:id/download`
- `PUT /api/files/:id/completion`

### Annotations
- `GET /api/annotations/:fileId`
- `POST /api/annotations`
- `PUT /api/annotations/:id`
- `DELETE /api/annotations/:id`
- `GET /api/annotations/song-names/unique`
- `POST /api/annotations/song-names/rename`
- `GET /api/annotations/songs`

### Prediction Reviews
- `GET /api/prediction-reviews`
- `GET /api/prediction-reviews/queue`
- `GET /api/prediction-reviews/:id`
- `POST /api/prediction-reviews`
- `POST /api/prediction-reviews/bulk`
- `PUT /api/prediction-reviews/:id`
- `POST /api/prediction-reviews/:id/promote`
- `POST /api/prediction-reviews/promote-reviewed`
- `POST /api/prediction-reviews/merge`
- `POST /api/prediction-reviews/run`
- `POST /api/prediction-reviews/rebuild-model`

### Ignored Sections
- `GET /api/ignored-sections?fileId=<id>`
- `POST /api/ignored-sections`
- `DELETE /api/ignored-sections/:id`

## Local Data Layout

- SQLite DB: `data/jamcoda.db`
- Synced MIDI files: `data/midi/YYYY-MM-DD/<filename>.mid`

Main tables:
- `files`: synced file metadata + completion flags
- `annotations`: human-labeled song segments
- `prediction_reviews`: model proposals + review decisions + promotion linkage
- `ignored_sections`: ranges intentionally excluded from annotation/prediction
- `sync_metadata`: last sync metadata

## Playback Notes

- Playback uses Magenta `SoundFontPlayer`.
- MIDI tracks are normalized to acoustic grand piano for consistency.
- Service worker caches only grand piano soundfont assets (`public/soundfont-cache-sw.js`).
- Sidebar shows cache registration and cached asset count.

## Development

### Prerequisites
- Node.js 22+
- Jamcorder reachable at `http://jamcorder.local` (or set `JAMCORDER_URL`)
- `sqlite3` CLI installed (required for some ML scripts in `ml/`)

### Install

```bash
npm install
```

### Set up

```bash
npm run setup
```

This asks where your Jamcorder is and where you want your data stored, then
writes a `.env` file for you. Press Enter at each prompt to accept the default.
It also checks that your Jamcorder actually answers at the address you gave, so
a typo or an offline device shows up now rather than at your first sync. That
check is advisory — you can save an address for a device that is not switched
on yet. It is safe to re-run at any time — your current answers become the new
defaults.

Prefer to do it by hand? Copy `.env.example` to `.env` and edit it. Skipping
this step entirely also works; the defaults in the table below are used.

### Run

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`

Vite proxies local APIs first (`/api/sync`, `/api/files`, `/api/annotations`, `/api/prediction-reviews`, `/api/ignored-sections`) and then forwards remaining `/api/*` to Jamcorder.

## Configuration

All configuration is optional and read from environment variables. Run `npm run setup` to
fill these in interactively, or copy `.env.example` to `.env` and edit it by hand.

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `JAMCORDER_URL` | `http://jamcorder.local` | Backend, Vite proxy, frontend | Base URL of your Jamcorder device (mDNS name or IP). |
| `JAMCODA_DB_PATH` | `./data/jamcoda.db` | Backend + ML scripts | Override the SQLite database location. |
| `JAMCODA_MIDI_DIR` | `./data/midi` | Backend (sync) | Where synced MIDI files are written. Absolute paths are supported, so the library can live outside the repo. |

Note: the local backend always runs on `http://localhost:3001`.

## Scripts

- `npm run setup`: interactive first-run setup; writes `.env`
- `npm run dev`: run client + server
- `npm run build`: typecheck + Vite build
- `npm run preview`: preview production build
- `npm run test:client`: run frontend tests (Vitest + Testing Library)
- `npm run test:server`: run backend tests (node:test)
- `npm run db:migrate`: run all pending DB migrations
- `npm run ml:train`: train model from annotations
- `npm run ml:predict`: predict segments from one MIDI file
- `npm run ml:predict-import`: predict and import into `prediction_reviews`
- `npm run ml:eval`: evaluate model predictions against existing annotations and write JSON report

## Database Migrations

- Startup applies migrations automatically through `server/config/migrations.ts`.
- Run migrations manually with `npm run db:migrate`.
- To target a non-default DB path:
  - `npm run db:migrate -- --db /absolute/path/to/jamcoda.db`
- Applied migrations are tracked in `schema_migrations`.

## Coding Agent Quick Start

Read these first:
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

Important behavior constraints:
- File completion is authoritative and blocks `/api/prediction-reviews/run`.
- Marking complete clears prediction rows for that file.
- Prediction generation excludes existing annotation ranges for that file.
- Prediction generation excludes time ranges saved in `ignored_sections`.
- Creating an ignored section deletes overlapping unpromoted prediction rows for that file.
- Merge creates one new `edited` row and marks source rows `invalid`.
- Promotion only accepts `confirmed` or `edited`.
- Playback is forced piano regardless of MIDI instrument program.
- Hash routing is used throughout (`window.location.hash`).

## Build

`npm run build` runs a full typecheck plus the Vite production build.

## Documentation

- [`API_NOTES.md`](API_NOTES.md) — Jamcorder behaviors we've learned that the official docs don't cover.
- Official Jamcorder device API reference: <https://www.jamcorder.com/docs/device-api>
- Official JMX MIDI file format spec: <https://www.jamcorder.com/docs/jmx-midi-files>
- ML workflow details: [`ml/README.md`](ml/README.md)

## Security Notes

`npm audit` reports known vulnerabilities in transitive dependencies of
`@magenta/music@1.23.1` (the last published release, from 2021):

- `protobufjs@6.x` (critical, no patched release for the 6.x line)
- `minimist@0.0.8` via `quote-stream` → `static-module` → `cwise` (critical)
- `static-eval@0.2.4` (high) via the same `cwise` chain

There is no upstream fix — `@magenta/music` pins an ancient `@tensorflow/tfjs`
tree, so neither `npm audit fix` nor `overrides` can clear these. Accepted
risk: these packages are only reachable in the client-side MIDI playback /
piano roll bundle (`src/hooks/useMidiPlayer.ts`,
`src/components/midi/PianoRollVisualizer.tsx`), the vulnerable code paths
require crafted/protobuf input, and the app only ever parses MIDI files from
the user's own Jamcorder. Resolve this properly by replacing `@magenta/music`
(`midi-file` is already a dependency and could drive parsing; playback and the
piano roll renderer can be built on Web Audio + custom SVG).

All other advisories from `npm audit` are expected to be clear.

## License

MIT — see [`LICENSE`](LICENSE).
