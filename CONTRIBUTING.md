# Contributing

## Scope

This project is local-first and optimized for Jamcorder MIDI workflows.
Changes should preserve product invariants described in `AGENTS.md` and `README.md`.

## Setup

1. Install dependencies:
   - `npm install`
2. Configure (optional; defaults work):
   - `npm run setup`
3. Run DB migrations:
   - `npm run db:migrate`
4. Start the app:
   - `npm run dev`

## Tests

Run them:
- Everything: `npm test`
- Server only: `npm run test:server`
- Frontend + shared core: `npm run test:client`
- Typecheck (`src`, `core`, `server`, `ml`, tooling): `npm run typecheck`
- Build check: `npm run build`

Put a new test next to the file it tests (`core/timeRanges.test.ts` beside
`core/timeRanges.ts`), using an infix to scope one feature of a large module:
`Annotation.merge.test.ts`. Shared client helpers live in `src/test/`.

Vitest runs everything, in two projects: `client` (jsdom) for `src/` and
`core/`, `server` (node) for `server/` and `ml/`. Server tests may assert with
`node:assert/strict` or Vitest's `expect`.

Server tests must set `JAMCODA_DB_PATH` to a temp database *before* importing
any model (import them lazily). Running tests against the real `data/jamcoda.db`
is refused outright.

## Database Changes

- Add schema changes as a new file under `server/config/migrations/`.
- Keep migrations additive and idempotent.
- Never hand-edit `data/jamcoda.db` in commits.

## ML + Review Semantics

Preserve these rules:
- Complete files block `POST /api/prediction-reviews/run`.
- Marking complete removes all `prediction_reviews` rows for that file.
- Prediction review statuses: `unsure | invalid | confirmed | edited`.
- Promotion allowed only for `confirmed` and `edited`.
- Merge requires same file + same resolved song and creates one `edited` row while marking source rows `invalid`.

## Pull Requests

CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on every pull
request. Run the same three locally before pushing.

- Include a short summary of behavior changes.
- List validation steps you ran.
- Mention any known follow-up work or residual risks.
