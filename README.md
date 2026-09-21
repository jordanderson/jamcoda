# JamCoda

[![CI](https://github.com/jordanderson/jamcoda/actions/workflows/ci.yml/badge.svg)](https://github.com/jordanderson/jamcoda/actions/workflows/ci.yml)

JamCoda is a local-first MIDI workflow for Jamcorder practice sessions.

A practice recording is one long file containing several pieces, a few attempts
at each, and a lot of improvising. JamCoda does four things end-to-end:

1. Sync `.mid/.midi` files from the Jamcorder into local storage.
2. Annotate song segments with start/end times.
3. Run an ML segmentation model that proposes song segments.
4. Review, edit, and promote those proposals into new annotations.

Everything stays on your machine. There is no account, and no server beyond the
local one this repo starts.

## Workflow

### Sync and browse

`Sync Now` in the sidebar pulls new recordings. Recordings containing no notes
are not imported — the device sometimes opens and closes assets without
recording — and the sync summary reports how many were ignored.

Files land in `#/browse` with annotation progress, an unreviewed prediction
count, and song chips that jump to a timestamp.

### Annotate

Open a file at `#/detail/:id` for the piano roll. Play with `P`, mark a segment
with `S` and `E`, clear with `C`, or drag a region directly on the roll.
Annotations can be edited, split at a silent gap, trimmed, or snapped to the
notes actually played.

The roll also shows the device's own markers: passage bookmarks and recorded
pauses.

`Mark Complete` declares the remaining unannotated time to be improvisation.
This matters beyond bookkeeping — training draws its "no song" examples only
from complete files. Marking a file complete also clears its predictions and
blocks further prediction runs until it is marked incomplete.

### Review predictions

`Run Predictions` generates proposals for the open file. They appear as
segments on the roll; click one to review it against the audio, then
`Confirm & Promote`, `Edit & Promote`, or `Mark Invalid`. Promoting turns a
proposal into an annotation the next rebuild can learn from.

Review statuses are `unsure`, `invalid`, `confirmed` and `edited`. Only
`confirmed` and `edited` can be promoted, and only `edited` uses the values a
reviewer typed.

Prediction Lab, on the same page, previews how different decoder settings would
change the proposals before you commit a run.

### Songs and analytics

`#/songs` lists every annotated segment across all files, so you can play takes
of one piece from different sessions back to back. Filter with the dropdown or
`#/songs?song=<name>`, and rename a song globally — the rename updates
annotations and prediction reviews together, then offers a model rebuild.

`#/analytics` groups practice time by song and date over a chosen range
(Last 30d / 90d / 6m / All time / Custom) and periodicity (Auto / Day / Week /
Month), with top-song bars, a practice-over-time trend, and a sortable table.

### Rebuild the model

`Rebuild Model` in the sidebar retrains from all current annotations and writes
`data/ml/model.json`. It is always manual. The button shows a badge when
annotations have changed since the model was built, or when songs exist that
the model has never seen.

## Getting started

### Prerequisites

- Node.js 22+ (`.nvmrc` pins 22; run `nvm use` if you use nvm)
- A Jamcorder reachable at `http://jamcorder.local`, or set `JAMCORDER_URL`

### Install and set up

```bash
npm install
npm run setup
```

`npm run setup` asks where your Jamcorder is and where to keep your data, then
writes `.env`. Press Enter to accept each default. It checks that the device
answers, so a typo or an offline device surfaces now rather than at first sync
— the check is advisory, and you can save an address for a device that is not
switched on yet. Re-run it any time; your current answers become the defaults.

To do it by hand, copy `.env.example` to `.env` and edit. Skipping setup
entirely also works: the defaults below apply.

> `better-sqlite3` is a native module, and its compiled binary is tied to the
> Node major version that installed it. Installing under a different major
> leaves the server failing at startup with `ERR_DLOPEN_FAILED` and a
> `NODE_MODULE_VERSION` mismatch. Typecheck, build and the client are all
> unaffected, which makes the cause easy to miss. Fix with
> `nvm use && npm rebuild better-sqlite3`.

### Run

```bash
npm run dev
```

Frontend on `http://localhost:5173`, backend on `http://localhost:3001`. Vite
serves the local API routes first, then forwards any remaining `/api/*` to the
Jamcorder.

## Configuration

All configuration is optional and read from environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `JAMCORDER_URL` | `http://jamcorder.local` | Base URL of your Jamcorder (mDNS name or IP). |
| `JAMCODA_DB_PATH` | `./data/jamcoda.db` | SQLite database location. |
| `JAMCODA_MIDI_DIR` | `./data/midi` | Where synced MIDI files are written. Absolute paths work, so the library can live outside the repo. |
| `JAMCORDER_LIBRARY_PAGE_SIZE` | `5` | Assets per library API page during sync. Keep it small; large pages can crash low-power firmware. |
| `JAMCORDER_LIBRARY_PAGE_DELAY_MS` | `1000` | Pause between library pages. |
| `JAMCODA_SYNC_DOWNLOAD_PACE_MS` | `300` | Pause between file downloads. |
| `JAMCODA_SYNC_EMPTY_ASSET_MAX_BYTES` | `1024` | Device assets at or below this size hold no notes and are not imported. |

The local backend always runs on port 3001.

## Local data

Everything lives under `data/`, which is gitignored:

- `data/jamcoda.db` — SQLite
- `data/midi/YYYY-MM-DD/<filename>.mid` — synced recordings
- `data/ml/` — trained models and evaluation reports

Tables: `files` (synced metadata and completion), `annotations` (your labels),
`prediction_reviews` (model proposals and review decisions), `sync_metadata`.

Migrations run automatically at startup and are tracked in `schema_migrations`.
Run them by hand with `npm run db:migrate`, adding
`-- --db /path/to/jamcoda.db` to target another database.

## Scripts

| Script | Does |
| --- | --- |
| `npm run dev` | Client + server |
| `npm run build` | Typecheck + Vite production build |
| `npm run typecheck` | `src/`, `core/`, `server/`, `ml/` and tooling |
| `npm test` | All tests (Vitest; `--project server` or `client` to narrow) |
| `npm run setup` | Interactive first-run setup; writes `.env` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:prune-empty` | Delete synced recordings with no notes (add `--apply`) |
| `npm run db:backfill-bookmarks` | Parse JMX passage bookmarks for already-synced files |
| `npm run db:repair-promotions` | Re-link promotions orphaned by a deleted annotation |
| `npm run db:rescale-silent-tempo` | Rescale times captured before the tempo fix (`--verify` checks only) |
| `npm run ml:train` | Train a model from annotations |
| `npm run ml:predict` | Predict segments for one MIDI file |
| `npm run ml:predict-import` | Predict and import into `prediction_reviews` |
| `npm run ml:predict-missing` | Same, for every incomplete file with no predictions (`--force` re-runs) |
| `npm run ml:eval` | Leave-one-out evaluation; writes a JSON report |
| `npm run ml:compare` | Diff two evaluation reports |
| `npm run ml:fit-confidence` | Refit the display-only confidence calibration |

## Playback

Playback uses a small Web Audio sampler (`src/audio/pianoSampler.ts`) with no
audio dependencies. Everything is normalised to acoustic grand piano regardless
of the MIDI program; the sampler loads no other instrument. Samples come from
the `sgm_plus` soundfont (`p{pitch}_v{velocity}.mp3`, pitches 21-108, eight
velocity layers). The piano roll draws its own SVG note rects.

## Architecture

- `core/` — pure, isomorphic domain code shared by every tier: DB row shapes,
  MIDI decoding, the Jamcorder tempo fix, range algebra, prediction-review
  rules. Start here.
- `src/` — React + Vite, hash routing (`#/browse`, `#/detail/:id`, `#/songs`,
  `#/analytics`).
- `server/` — Express on port 3001, `better-sqlite3`, migrations.
- `ml/` — the segmentation model; `ml/songSegmentation.ts` is the public
  surface over `ml/segmentation/`.

`AGENTS.md` is the working runbook: shared helpers, conventions, and the
invariants that must hold across tiers. Read it before changing behaviour that
exists on more than one side of a boundary.

## Documentation

- [How JamCoda finds the songs](docs/how-jamcoda-finds-the-songs.html) — an
  illustrated walkthrough of the segmentation pipeline.
- [`ml/README.md`](ml/README.md) — model commands, settings and evaluation.
- [`ml/CHANGELOG.md`](ml/CHANGELOG.md) — model versions and the experiments
  behind them.
- [`API_NOTES.md`](API_NOTES.md) — Jamcorder device behaviour the official docs
  do not cover.
- [`AGENTS.md`](AGENTS.md) — repo runbook and invariants.
- Official [device API](https://www.jamcorder.com/docs/device-api) and
  [JMX MIDI format](https://www.jamcorder.com/docs/jmx-midi-files) references.

## Dependencies

The dependency tree is deliberately small. MIDI decoding
(`core/midi/noteSequence.ts`, on `midi-file`), playback
(`src/audio/pianoSampler.ts`, Web Audio) and the piano roll (plain SVG) are all
implemented here rather than taken from a framework, so no ML or audio
framework is installed.

Keep `npm audit` clean. It currently reports one low-severity advisory in a
build-only transitive dependency (`postcss-selector-parser`, via Tailwind),
with a fix available.

## License

MIT. See [`LICENSE`](LICENSE).
