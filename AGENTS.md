# AGENTS.md

Repo-specific execution guidance. Product and setup are in `README.md`; model
details are in `ml/README.md`.

Start in `core/` — pure, isomorphic domain code with no I/O, typechecked
against both the DOM and Node libs, and the single home for any rule that
applies on more than one side of a tier boundary. `core/cli/` is the one
deliberately Node-only part.

## Gotchas

- **SQLite is Node's built-in `node:sqlite`, which needs Node 24** (`.nvmrc`).
  There is no native module, so no rebuild for Electron or across Node
  versions. Transactions go through `transaction(db, fn)` in
  `server/config/transaction.ts` (savepoints when nested). Rows are typed
  `Record<string, SQLOutputValue>` and cast via `unknown`; `changes` and
  `lastInsertRowid` are typed `number | bigint` but are numbers unless
  `readBigInts` is set.
- **The desktop app runs the server as an Electron utility process**
  (`server/desktopHost.ts`) with `JAMCODA_LOOPBACK_ONLY=1`: loopback bind, no
  CORS, and `server/utils/loopbackGuard.ts` refusing any other `Host` or
  `Origin`. Unset, the server behaves as it does for `npm run dev`. Keep
  desktop-only behavior behind that flag or `JAMCODA_CLIENT_DIST_DIR`.
- **`.env` reaches server code only through `--env-file-if-exists=.env`** on
  each tsx script in `package.json`; Vite reads it separately. The flag applies
  before any module reads `process.env` at import time, which a
  `loadEnvFile()` call in an entry file would not. A new script needs the flag,
  and `server/envFile.test.ts` fails without it.
- **Vitest runs every test, in two projects** (`vite.config.ts`): `client`
  (jsdom) covers `src/` and `core/`; `server` (node) covers `server/` and
  `ml/`. `npm test` runs both; `--project server` or `--project client` narrows
  it. Server tests assert with `node:assert/strict`, which works unchanged
  inside Vitest.
- **A server test must point `JAMCODA_DB_PATH` at a temp database before
  importing any model**, and import models lazily. `initializeDatabase()`
  refuses to run under `NODE_ENV=test` against the app DB, and Vitest sets
  `NODE_ENV=test` for you.
- **No `.js` extension on relative imports.** `moduleResolution` is `bundler`
  and nothing emits Node ESM. Prefer the path aliases (`@core/*`, `@/*`,
  `@server/*`, `@models/*`, `@utils/*`, `@config/*`).
- Sync changes are verified with tests, never by syncing a real device.

## Shared Helpers

Check these before writing a local copy:

- `core/errors.ts` — `errorMessage(error, fallback)`; never re-inline the
  `instanceof Error` check.
- `core/timeRanges.ts`, `core/predictionReview.ts`, `core/math.ts` — domain
  rules used on both sides of the HTTP boundary.
- `core/predictionConfidence.ts` — display calibration, plus
  `confidenceFeatures`, which `ml:fit-confidence` also calls so the fit and the
  scorer agree on what the weights multiply.
- `server/utils/` — `route(action, handler)` (wraps a route so a throw becomes
  one logged 500), request-param parsers, `nowUnix()`.
- `src/utils/format.ts` — all display formatting.

## Invariants

### Reviews and completion

- File completion is authoritative: `POST /api/prediction-reviews/run` rejects
  complete files, and marking a file complete clears its `prediction_reviews`
  rows.
- Statuses are `unsure | invalid | confirmed | edited`. Only `confirmed` and
  `edited` can be promoted.
- **A review resolves to `reviewed_*` only when its status is `edited`**;
  everything else uses `predicted_*`. This lives once, in
  `core/predictionReview.ts` — `resolveReviewFields()` and the `RESOLVED_*_SQL`
  fragments. Never re-express it inline or as a bare `COALESCE`: `update()`
  writes `reviewed_*` and `status` independently, so a row can hold reviewed
  values while still `unsure`, and the two paths then disagree.
- Merge requires the same file and same resolved song; it creates one `edited`
  row and marks the sources `invalid`.
- Song rename updates annotation and prediction-review name fields together.
- The prediction pipeline has one implementation,
  `server/services/predictionImport.ts`, called by both the API route and
  `ml:predict-import`. Neither reimplements exclusion, inserts, or schema.
- The staleness badge is read-only: `GET /api/prediction-reviews/rebuild-status`
  compares annotation `updated_at` against the model's `createdAt`, and current
  song names against the model's labels. It never trains, and it must clear
  after a rebuild.

### Model

- **Compare model variants on the complete-files row of the eval report, never
  the aggregate.** `ml:eval` reports three ways: complete files, incomplete,
  and everything. Precision only means something where annotation is finished —
  an incomplete file scores a *correct* prediction against unannotated time, so
  the same model reads 85% precision on complete files and 38% on incomplete
  ones. The aggregate tracks annotation coverage, not the model, and moves less
  than a point across changes worth three on the honest number.
- **`__none__` training windows come only from complete files**
  (`TrainConfig.noneFromCompleteFilesOnly`, on by default, falling back to every
  file when none is complete). An unannotated window asserts "no song" only
  where the user declared the file finished; elsewhere it is an unreviewed gap,
  and training on it teaches the model that real performances are silence.
  Marking a file complete has model value, not just bookkeeping value. The v2.10
  changelog entry rejected this setting; the v2.12 entry re-measured it and
  supersedes that result.
- **Bridge linking is the training default, and an absent `linkPolicy` decodes
  as legacy.** `resolveTrainConfig` fills `linkPolicy: 'bridge'`
  (`linkTailSec: 2`, `linkRescueRank: 5`) so a model records its own policy;
  `anchorLinkDecode` reads a *missing* policy as `legacy`, which is what keeps
  an older saved model decoding the way it was built. Do not collapse that
  asymmetry into one default — a new default must never move an existing model.
  Both halves are asserted in `ml/songSegmentation.linking.test.ts`.
- `ml/CHANGELOG.md` is the committed record of model experiments: what shipped
  and what failed. Working notes, reports and database snapshots stay out of the
  repository, and committed files never cite them.

### MIDI decoding

One implementation, `core/midi/noteSequence.ts`, which pairs note events itself
rather than delegating to a library.

- **All Notes Off (CC 123) and All Sound Off (CC 120) end every sounding note on
  their channel.** The Jamcorder emits these instead of a Note Off per key when
  it goes idle — 158 across the library, so this is not an edge case. A decoder
  that pairs only Note On to Note Off leaves notes open, and the orphan takes
  the release belonging to the next press of that pitch, shifting every later
  note of that pitch for the rest of the file.
- **Never split a track on `programChange`.** Jamcorder files are format 0, one
  track, one channel; a program change is a patch switch mid-performance, not a
  separate instrument. Splitting there and pairing within each split strands any
  note whose release lands after the switch.
- Notes still sounding at the end of a track are dropped, not extended —
  nothing released them, so there is no honest end time. A note ended by All
  Notes Off is capped at `MAX_ALL_NOTES_OFF_SECONDS`, that end being an upper
  bound rather than a measured release.
- **A Jamcorder recording is on the JMX grid of one millisecond per tick even
  when it declares no tempo.** 89 of 235 files write no Set Tempo event;
  reading those at the SMF default of 120 BPM stretches them by 9.17%
  (500000/458000) and their notes then disagree with their own device markers,
  which `jmxParser` reads off the JMX grid. `core/midi/tempoMap.ts` detects a
  Jamcorder file by its `jmx…` sequencer-specific markers and uses
  `ticksPerBeat * 1000`; that same detection gates the late-tempo mirror, so a
  non-JMX file keeps standard SMF behavior.
- The check that catches all of this: decoded duration must match the `jmxEof`
  trailer's `totalMillis`, the device's own statement of how long it recorded.
  `npm run db:rescale-silent-tempo -- --verify` asserts it across the library.

### Library

- **A library is the folder holding `jamcoda.db`**; `midi/` and `ml/model.json`
  sit beside it. `server/config/library.ts` is the one place those paths are
  derived, from `JAMCODA_DB_PATH`, never from the working directory.
- **`files.local_path` is relative to the library folder**, forward-slashed.
  Resolve it with `resolveStoredMidiPath` and write it with `toStoredMidiPath`;
  an absolute path in the database ties the library to one machine.
- The desktop app never creates a library in place of a configured one it
  cannot find; it asks. `electron/main.ts`, `startServerWithRecovery`.

### Sync

- Discovery is a filesystem walk over the detailed listing (real sizes → skip
  unchanged), falling back to the library API only when the walk fails, with a
  high-water mark to keep that fallback cheap. `POST /api/sync/start?full=1`
  forces a full pass. The library API is crash-prone on low-power firmware and
  is never the primary source.
- Firmware is resource-constrained and may drop requests or crash: small pages,
  generous inter-page and inter-download delays, per-page and per-file retries.
- A device file smaller than the synced copy is skipped with a warning — never
  overwrite local data with a truncated download.
- A *new* device asset with no notes is not imported: skipped on reported size
  before download, and on the JMX trailer's `totalNotes`/`totalMillis` after.
  The device makes these in bursts, and importing them buries real recordings.
  Never infer emptiness from a local parse failure. See `API_NOTES.md`.

### Playback and the piano roll

- Playback is normalized to grand piano; `src/audio/pianoSampler.ts` loads no
  other instrument.
- Follow-playback has one rule, in `src/components/midi/pianoRollFollow.ts`:
  ease the viewport so the playhead sits at `FOLLOW_ANCHOR` of the visible
  width, clamped to the scroll range. Stop, restart, seek and re-enable all
  follow from that target. Per-playback-state branches disagree at the
  transitions between states.
- A user scroll needs a scroll-producing *input* (wheel, touch drag, scroll key,
  scrollbar grab) **and** a `scroll` event confirming it moved. Inferring it
  from scroll events alone, or from timestamps against our own scrolling, both
  switches follow off mid-playback and misses real manual scrolls. A press
  inside the roll is a seek, and clears the latch.
- `useMidiPlayer` starts playback asynchronously. Every halt bumps
  `playbackGenerationRef`, and `beginPlayback` bails if it moved while awaiting
  samples; without that a stop or pause during the load window is dropped and
  audio starts anyway.
- The detail page re-renders every animation frame during playback, so the
  roll's layers and the annotation list sit behind `memo` with
  `useCallback`-stable handlers. An unmemoised array or inline handler there
  silently restores a full-page render at 60fps.

## Before Finishing

Run `npm run typecheck`, `npm test`, and `npm run build`. Touching the model or
sync also means exercising the rebuild and run-prediction endpoints, or the
`ml:predict-import` CLI path, against a real file.

Write comments and docs as statements of current behavior. Do not narrate what
a change replaced or improved — that belongs in git. Model results are the
exception: `ml/CHANGELOG.md` keeps the before/after so failed ideas are not
retried.

Write American English — `behavior`, `color`, `gray`, `labeled`, `neighbor`,
`recognize`, `normalized` — in comments, docs, `docs/*.html`, UI copy, and our
own identifiers (variables, functions, types, test names) alike, with dates
written `September 7, 2026`. Third-party names and APIs keep their own
spelling.
