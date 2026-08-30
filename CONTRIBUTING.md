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

- Run server tests:
  - `npm run test:server`
- Run frontend tests:
  - `npm run test:client`
- Build check:
  - `npm run build`

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
