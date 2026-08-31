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

Where to put a new test:
- **Co-located next to the file it tests** -- `core/timeRanges.test.ts` beside
  `core/timeRanges.ts`. We do not use `__tests__/` directories.
- To cover one feature of a large module, use an infix:
  `Annotation.merge.test.ts`.
- Shared client helpers live in `src/test/`, not beside a module.

Which runner to write against depends on the directory:
- `core/` and `src/` use **Vitest** -- `import { describe, it, expect } from 'vitest'`.
- `server/` uses **Node's built-in test runner** -- `node:test` and
  `node:assert/strict`. Vitest globals do not exist there.

Server tests must set `JAMCODA_DB_PATH` to a temp database *before* importing
any model (import them lazily). Running tests against the real `data/jamcoda.db`
is refused outright.

## Database Changes

- Add schema changes through `server/config/migrations.ts`.
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

- Include a short summary of behavior changes.
- List validation steps you ran.
- Mention any known follow-up work or residual risks.
