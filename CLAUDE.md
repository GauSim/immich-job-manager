# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

Immich Album Jobs: a companion app for Immich v3 that runs rerunnable batch jobs and syncs matching assets into Immich albums. First job: screenshot detector.

- Design: `docs/design/immich-album-jobs-SDD.md`
- Plan: `docs/design/immich-album-jobs-implementation-plan.md`
- Immich API findings: `docs/immich-api-notes.md` (read before touching the Immich client; it overrides the SDD where they differ, e.g. cursor pagination)

## Implementation plan tracking (important)

While implementing, **keep the implementation plan up to date**:

- Check off each task in `docs/design/immich-album-jobs-implementation-plan.md` (`- [ ]` → `- [x]`) as soon as it is done, in the same commit as the work.
- Check off the phase's deliverables / "Done when" items once verified.
- If a task is done differently than planned, or deferred, add a short indented note under it (e.g. `  - Note: …`) instead of silently changing the task.
- Update the phase status line (`**Status:**`) when a phase starts or finishes.
- Work phases in order; don't start a phase before its dependencies are checked off.

## Layout

| Path | What |
| --- | --- |
| `backend/` | NestJS 12, ESM (`.js` suffix in relative imports), Vitest, oxlint, Prettier |
| `frontend/` | Angular 22 standalone + signals, Angular Material, Vitest (`ng test`), angular-eslint |
| `tools/immich-spike/` | API spike script (`@immich/sdk`), run against a real Immich |
| `worker-py/` | Placeholder (phase 9) |

`backend` and `frontend` are independent npm packages with their own lockfiles (no workspaces). Node 22 (`.nvmrc`).

## Commands

Run in the package directory:

| | backend | frontend |
| --- | --- | --- |
| install | `npm ci` | `npm ci` |
| lint | `npm run lint` | `npm run lint` |
| format | `npm run format` / `format:check` | `npm run format` / `format:check` |
| typecheck | `npm run typecheck` (incl. tests) | (part of build) |
| test | `npm test`, `npm run test:e2e`; contract vs real Immich: `npm run test:contract`; `npm run test:scale` (see backend README) | `npm test`; UI e2e: `npm run e2e:prepare && npm run e2e` (Playwright) |
| build | `npm run build` | `npm run build` |

Migrations: see `backend/README.md` (generate after every entity change; register in `migrations/index.ts`).

Before committing, run lint, format check, typecheck, tests and build for every package you touched. CI (`.github/workflows/ci.yml`) runs the same plus a Docker build and `/api/health` smoke test.

## Conventions

- Talk to Immich only through `ImmichClient` (`backend/src/immich/`), never raw `fetch` or the SDK elsewhere.
- Database writes: never TypeORM transactions or `save()` (TypeORM's SQLite driver shares one query runner, so async transactions collide). Multi-statement writes go through `SqliteService.transaction()` (synchronous better-sqlite3); otherwise single-statement `insert` / `update` / `delete`.
- Review generated migrations: for SQLite TypeORM often rebuilds tables (DROP + copy), which cascades deletes through foreign keys. Prefer hand-written `ALTER TABLE … ADD COLUMN`.
- New job types: a provider with `@AlbumJobType()` implementing `JobType` (`src/core/job-type.ts`), listed in `JOB_TYPES` (`src/jobs/job-types.module.ts`). Use the blocks in `src/core/blocks/`; yield one page at a time.
- Long-lived `AbortSignal`s (a run's) must not be passed straight to `fetch` for many requests: `ImmichClient` links a per-request signal (`linkSignal`) and releases it. Reuse option objects for libraries that cache per options instance (e.g. `exifr`).
- Album writes go through `AlbumSyncService` (`src/sync/`); only assets recorded in `job_asset` (owned) may ever be removed. Dry runs must never change Immich.
- Config comes from the injected `APP_CONFIG` (`AppConfig`), never `process.env` outside `config/` and `main.ts`.
- Immich v3.x only; `@immich/sdk` pinned to the server's version.
- All HTTP routes under `/api`.
- No secrets in the repo, DB or browser; secrets come from `*_FILE` env vars / Docker secrets.
- New config → `.env.example` and README.
- Frontend: standalone components + signals, lazy routes; job params UI is generated from the job type's JSON Schema (never hand-write per-type forms). Formly is provided on the job-editor routes only (keeps the initial bundle small). Use `data-testid` for elements the Playwright tests use.
- Don't run `pkill -f`/`pgrep -f` with a pattern that also appears in the same shell command (the tool's shell wrapper contains the command text and gets killed).
