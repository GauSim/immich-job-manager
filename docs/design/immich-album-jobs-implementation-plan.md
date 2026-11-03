# Immich Album Jobs – Implementation Plan

| | |
| --- | --- |
| Version | 1.0 |
| Date | 2026-11-03 |
| Owner | Simon |
| Based on | `immich-album-jobs-SDD.md` v1.0 |

---

## 1. Summary

Eight phases, built in strict order. Each phase ends with something runnable and testable. The screenshot album is **usable after phase 5** (manual runs). It is **fully automated after phase 7** (scheduled, incremental, scaled to 30k+ assets).

| Phase | Goal | Depends on | Size | Milestone |
| --- | --- | --- | --- | --- |
| 0 | Repo, tooling, CI, API spike | – | S | – |
| 1 | Backend foundation: config, DB, Immich client | 0 | M | Connects to Immich |
| 2 | Job framework: types, runner, runs, resume | 1 | L | Runs a dummy job |
| 3 | Screenshot job (metadata signals), dry run | 2 | M | First dry-run results via API |
| 4 | Frontend: shell, dashboard, job editor, run detail, review grid | 3 | L | **M1: preview in the UI** |
| 5 | Album sync: additive, mirror, exclusion, apply | 3, 4 | M | **M2: screenshot album filled** |
| 6 | iOS tag, feature cache, CLIP, scale tuning | 5 | M | Accurate on iPhone screenshots |
| 7 | Scheduler, incremental runs, housekeeping | 5 | S | **M3: fully automated** |
| 8 | Hardening, auth, packaging, docs | 7 | M | **v1.0 release** |
| 9 | Python worker (optional, later) | 8 | M | First ML job |

Size: S ≈ 1–2 evenings, M ≈ 3–5, L ≈ 6–10 (rough, solo developer).

```text
P0 ─► P1 ─► P2 ─► P3 ─┬─► P4 ─┐
                      └───────┴─► P5 ─┬─► P6 ─┐
                                      └─► P7 ─┴─► P8 ─► (P9)
```

P6 and P7 are independent and can be done in either order.

---

## 2. Phases

### Phase 0 – Repository, tooling, API spike

**Goal:** an empty but buildable monorepo, and certainty about the Immich v3 API shapes.

**Status:** done (2026-11-03)

Tasks:

- [x] Create repo layout:
  ```text
  immich-album-jobs/
    backend/          # NestJS
    frontend/         # Angular
    worker-py/        # empty placeholder
    docs/             # SDD, this plan
    Dockerfile
    docker-compose.yml
    .env.example
    secrets/.gitkeep  # gitignored contents
  ```
  - Note: repo is `immich-job-manager`; added `tools/immich-spike/` for the API spike and a root `package.json` with convenience scripts only.
- [x] Scaffold `nest new backend` and `ng new frontend --standalone --routing --style=scss`; add Angular Material.
  - Note: NestJS 12 (ESM, Vitest instead of Jest), Angular 22 (Vitest via `ng test`). Hello-world replaced by a placeholder `GET /api/health` (global prefix `api`) so the Docker healthcheck works; phase 1 extends it.
  - Note: backend Vitest bumped 4 → 5 (npm 10 crashed resolving the scaffold's Vitest 4 peer set).
- [x] Shared tooling: Node 22 via `.nvmrc`, ESLint + Prettier, `npm` workspaces or two independent packages.
  - Note: two independent packages (own lockfiles), matching the Dockerfile. Frontend lints with ESLint (`angular-eslint`); backend keeps NestJS 12's default **oxlint** (type-aware) instead of ESLint. Prettier in both, `format:check` in CI. Root `.editorconfig`.
- [x] CI (GitHub Actions or similar): lint, unit tests, build both apps, build Docker image.
  - Note: `.github/workflows/ci.yml` – backend, frontend, spike typecheck, Docker build + `/api/health` smoke test. Docker image built and smoke-tested locally and in CI. Runs on every branch push and on PRs to `main`.
- [x] **API spike** (scratch script with `@immich/sdk` against your instance):
  - [x] `GET /server/about` → confirm v3.x.
  - [x] `POST /search/metadata` with `type: IMAGE`, `withExif: true`, `size: 1000` → confirm `originalFileName`, `originalMimeType`, `exifInfo.make/model`, dimensions, `checksum`.
  - [x] `PUT /albums/{id}/assets` on a test album → confirm per-id response shape.
  - [x] `curl -r 0-65535` on `GET /assets/{id}/original` for an iPhone screenshot → check for `206 Partial Content`.
  - [x] Note required API key permissions.
  - Note: run against a throwaway Immich **v3.3.5** seeded with synthetic fixtures (`tools/immich-spike`), not yet against the real instance. Key findings: `page` is deprecated in v3.3 → use `filter` + `cursor`; `total` is per page; Range is honoured (206); `UserComment` comes back as raw bytes. See `docs/immich-api-notes.md` §9 for the impact on later phases.
  - [x] Rerun `npm run spike` against the real Immich instance (incl. `SPIKE_ASSET_ID` of a real iPhone screenshot) and diff with the notes.
    - Note: run on the NAS via `tools/immich-spike/docker-compose.yaml` (2026-11-03). All findings confirmed; omitted visibility also returns hidden assets, smart search verified with ML, Range + `UserComment` verified on a real iPhone screenshot. See `docs/immich-api-notes.md`.

- [x] **Deliverables:** repo, green CI, spike notes in `docs/immich-api-notes.md`.
  - Note: CI green on GitHub Actions (run #1: backend, frontend, spike typecheck, Docker build + health smoke test).

- [x] **Done when:** both apps build in CI; spike answers the open items in SDD §13.3.

---

### Phase 1 – Backend foundation

**Goal:** a NestJS app that starts, validates config, has a database, and talks to Immich.

**Status:** implemented (2026-11-03) – verified against a throwaway Immich v3.3.5; pending: health check against the real instance

Tasks:

- [x] `ConfigModule`: Zod schema for all env vars; read `*_FILE` secrets; fail fast with clear messages.
  - Note: validated in `main.ts` *before* Nest starts (`loadConfig()` collects every problem, prints a list, exits 1); `ConfigModule.forRoot(config)` provides the result as `APP_CONFIG`. Setting both `X` and `X_FILE` is an error. Added `LOG_LEVEL`; `IMMICH_URL` must end in `/api`. `backend/.env` is auto-loaded in development.
- [x] `PersistenceModule`: `@nestjs/typeorm` with `better-sqlite3`, WAL pragma, `synchronize: false`, migrations folder, migration run on boot.
  - Note: TypeORM 1.x with `better-sqlite3` 12 (TypeORM's peer range). Entities and migrations are registered as class lists, not globs (ESM-friendly). `foreign_keys = ON`, `synchronous = NORMAL`, 5 s busy timeout. `npm run migration:generate` runs the TypeORM CLI against the compiled `dist/`.
- [x] Entities + first migration: `job`, `job_run`, `run_candidate`, `job_asset`, `asset_feature`, `run_log`, `setting`, with indexes.
  - Note: snake_case columns via a naming strategy; FKs with `ON DELETE CASCADE` (`job_asset.added_by_run_id` → `SET NULL`). Beyond SDD §7: `job.created_at/updated_at`, `job_run.created_at` (queued at), indexes `job_run(job_id, created_at)`, `job_run(status)`, `run_log(run_id, id)`, `run_log(ts)`. `job_asset(job_id, asset_id)` and `asset_feature(asset_id)` are primary keys, so no extra index. A test asserts the migrations match the entities exactly.
- [x] `ImmichModule` / `ImmichClient`:
  - [x] SDK init with base URL and key.
    - Note: no global `init()`; every SDK call gets per-call options (base URL, key, retrying `fetch`, abort signal).
  - [x] `assertCompatible()` (major = 3) on boot.
    - Note (phase 0 spike): use `GET /server/version` (structured, no permission needed).
    - Note: incompatible major → boot fails; Immich unreachable → warning only (it may start after us), reported by `/api/health`.
  - [x] Retry with backoff on 429/5xx, `X-Correlation-ID` logging.
    - Note: 3 retries, exponential backoff with jitter, honours `Retry-After`; network errors retried too; abortable. Errors are typed (`ImmichApiError`, `ImmichUnreachableError`, `ImmichIncompatibleError`, `ImmichSmartSearchUnavailableError`) and carry the correlation id.
  - [x] Concurrency limiters (`p-limit`): API = 2, file reads = 4.
    - Note: file reads use `MAX_FILE_READS`. Thumbnails are not limited yet; the proxy decides in phase 3.
  - [x] Methods: `searchMetadataPage`, `searchSmart`, `findOrCreateAlbum`, `listAlbumMemberIds`, `addToAlbum` (chunked), `removeFromAlbum` (chunked), `readOriginalHead`, `getThumbnail`.
    - Note (phase 0 spike): `searchMetadataPage` must use the v3.3 `filter` + `orderBy` + `cursor` request style (`page` is deprecated); add/remove return per-id `success`/`error`. See `docs/immich-api-notes.md` §9.
    - Note: add/remove return `{ succeeded, unchanged, failed }` (`duplicate` / `not_found` → unchanged) and de-duplicate ids. `readOriginalHead` sends `Range` and aborts the stream after 64 KiB if the server ignores it. `searchSmart` still pages by number (unverified without ML) and maps a 500 to `ImmichSmartSearchUnavailableError`. `findOrCreateAlbum` matches owned albums by exact name.
- [x] `GET /api/health` (DB + Immich reachability + version).
  - Note: `status: ok | degraded | error`; HTTP 200 unless the database is down (503), so the container stays healthy while Immich restarts. Immich check: no retries, 3 s timeout.
- [x] Pino logging with request ids.
  - Note: `nestjs-pino`; request id from a valid incoming `x-request-id` or a new UUID, echoed in the response; API key / auth / cookie headers redacted; `/api/health` not access-logged; pretty output outside production.

- [x] **Deliverables:** `docker compose up` starts the backend; `/api/health` reports Immich v3.
  - Note: verified with the real `docker-compose.yml` (Docker secrets, `./data` volume) on the Immich network against a throwaway Immich v3.3.5: `{"status":"ok", … "version":"v3.3.5"}`, container `healthy`. `./data` must be writable by uid 1000 (documented in README).

- [x] **Tests:** config validation, ImmichClient against a mocked HTTP server (retries, chunking, version check).
  - Note: 41 unit tests (config, ImmichClient against a local fake Immich HTTP server, migrations ↔ entities), 5 e2e tests (boot + migrations, health ok/degraded/down, incompatible version refuses boot). Every client method was also exercised against the live throwaway v3.3.5. CI smoke-tests the image: invalid config exits 1; unreachable Immich → `degraded`.

- [ ] **Done when:** health endpoint is green against your real Immich; invalid config stops boot with a readable error.
  - Note: invalid config ✓ (locally and in CI). Health green against a throwaway Immich v3.3.5 ✓; still to confirm against the real instance.

---

### Phase 2 – Job framework and runner

**Goal:** generic job execution, before any real job logic.

**Status:** done (2026-11-03) – verified against a throwaway Immich v3.3.5; pending: noop run over the real library

Tasks:

- [x] `core/job-type.ts`: `JobType`, `JobContext`, `Candidate`, `CandidateBatch` interfaces.
  - Note: `JobContext` has no `features` (`AssetFeatureCache`) yet; added in phase 6. `CandidateBatch.cursor` is `string | null` (null = source exhausted) and may carry `filesRead` / `cacheHits`. Added `runId`, `jobId`, `dryRun` to the context.
- [x] `@AlbumJobType()` decorator + `JobTypesModule` discovery via `DiscoveryService`; params JSON Schema via `zod-to-json-schema`.
  - Note: JSON Schema via Zod 4's built-in `z.toJSONSchema` (draft-07, input types incl. defaults) instead of `zod-to-json-schema`. The registry rejects duplicate ids and invalid `defaultParams` at boot. Job types are listed in `JOB_TYPES` (`src/jobs/job-types.module.ts`).
- [x] Blocks: `metadataSource` (paged, cursor = page number + `updatedAfter`), `filenameScorer`, `exifScorer`, `albumSource`.
  - Note (phase 0 spike): cursor = Immich's opaque `nextCursor` (offset-based, so resume is at-least-once); `updatedAfter` → `filter.updatedAt.gt`.
  - Note: plus `scoreAsset` (sum capped at 1, reasons, "decisive" signals for the iOS tag) and EXIF predicates (`hasNoCameraExif`, `mimeTypeIs`, `dimensionsIn`, `aspectRatioAtLeast`). Filename patterns: case-insensitive substrings (typographic apostrophes normalised) or `/regex/flags`.
- [x] `RunQueue`: one run per job, `MAX_CONCURRENT_RUNS` overall, FIFO.
  - Note: the API enforces "one active run per job" atomically in SQL (409 otherwise); the queue also never starts two runs of a job and lets runs of other jobs pass a blocked one.
- [x] `RunExecutor`:
  - [x] Create `job_run`, iterate batches, persist each batch + cursor + totals in **one transaction per page**.
    - Note: the page transaction is a *synchronous* better-sqlite3 transaction (`SqliteService`), because TypeORM's SQLite driver shares one query runner and concurrent async transactions would interleave. Dry runs upsert `run_candidate` rows in the same transaction. The run is created by the API, not the executor.
  - [x] `AbortController` cancellation.
  - [x] On boot: `running` → `interrupted`.
    - Note: queued runs are re-queued on boot; on shutdown active runs are interrupted (resumable) before the DB closes.
  - [x] Resume from stored cursor.
    - Note: resume reuses the same run (totals continue); allowed for `interrupted` and `failed` runs.
- [x] `EventsModule`: SSE per run, throttled to 1 progress event/s, plus log lines.
  - Note: events `status` (snapshot first, final last; the stream then ends), `progress` (leading + trailing throttle), `log`. 15 s heartbeat comments.
- [x] Jobs API: `GET /job-types`, CRUD `/jobs`, `POST /jobs/:id/runs`, `GET /jobs/:id/runs`, `GET /runs/:id`, `POST /runs/:id/cancel`, `POST /runs/:id/resume`, `GET /runs/:id/events`.
  - Note: added `GET /runs/:id/logs?after=` (for the run detail page). Validation errors use Immich's shape `{ message: 'Validation failed', errors: [{ path, message }] }`, incl. job params (`['params', …]`) and cron. Album names are **job-level** fields (`targetAlbumName`, `exclusionAlbumName`, default `<target> – excluded`) rather than job-type params as in SDD §6.3, because album sync is core code; migration `JobAlbumNames` adds them. `dryRun: false` on a job in `dry-run` sync mode → 400. Real runs only count matches until phase 5 (logged as a warning).
- [x] A `noop-test` job type that pages through the library and matches nothing.

- [x] **Deliverables:** start, cancel and resume a run via API; watch progress via SSE.

- [x] **Tests:** runner with a fake source: cursor resume after simulated crash, cancellation, flat memory over 100k fake assets.
  - Note: also shutdown interrupt + resume after reboot, boot recovery, page-before-next-page ordering, throttling, queue rules, blocks; API e2e incl. SSE, 409s, resume after an Immich error (only the failed page is fetched again). 100k assets: heap growth bounded (< 64 MB).

- [ ] **Done when:** a noop run over your full library completes and reports the correct `scanned` count.
  - Note: verified against the throwaway Immich v3.3.5 (6 assets incl. 1 archived → `scanned: 6`, pages of 2 via real cursors; images/timeline only → 5). Still to run against the real library.

---

### Phase 3 – Screenshot job (metadata signals) and dry run

**Goal:** first real job, preview only.

**Status:** done (2026-11-03) – verified against a throwaway Immich v3.3.5 and a real-library metadata sample; pending: full dry run over the real library

Tasks:

- [x] `ScreenshotParams` Zod schema with defaults (threshold 0.6, patterns, resolution list, `readIosTag` false for now, CLIP disabled).
  - Note: album names are job-level fields (phase 2), not params. Resolutions are `"WIDTHxHEIGHT"` strings (simpler UI form than `[number, number]` tuples). Added `descriptionTags` (default `["Screenshot"]`) and `minAspectRatio` (default 2). `readIosTag` / `clip` exist but only log a warning until phase 6.
- [x] Scoring: filename, PNG, no camera EXIF, screen dimensions. Images only (`type: IMAGE`).
  - Note: plus a decisive **description-tag** signal: the real library showed that Immich's `exifInfo.description` of iPhone screenshots is `"Screenshot"` (API notes §4.2, §8a). Weights per SDD §6.1; screen size = listed resolution (either orientation) or aspect ≥ 2 without camera EXIF.
- [x] Reasons per candidate.
  - Note: the job also logs a per-signal match summary at the end of the run.
- [x] Dry-run persistence: `run_candidate` rows (batched), `selected = true` by default.
  - Note: done in phase 2 as part of the runner's page transaction (`RunStore`). Phase 3 adds `original_file_name` for the grid (migration `CandidateFileName`, hand-written).
- [x] Candidates API: `GET /runs/:id/candidates` (paged, sort by score, filter by score band), `PATCH /runs/:id/candidates` (tick/untick).
  - Note: `?sort=-score|score|name&minScore=&maxScore=&selected=&limit=&offset=`; responses include a `summary` (all, selected, unselected, high ≥ 0.8, medium) for the grid's chips. `PATCH` takes `{ selected, assetIds }` or `{ selected, filter }` (no ids/filter = all); 409 for non-dry runs.
- [x] Thumbnail proxy `GET /assets/:id/thumbnail` (only assets present in a run).
  - Note: guarded by an `asset_id` index on `run_candidate`; streams Immich's thumbnail with `Cache-Control: private, max-age=86400`; own concurrency limit (6) in `ImmichClient`; Immich 404 → 404.
- [x] Fixture set: anonymised metadata JSON for screenshots, camera photos and edge cases (exported graphics, wallpapers).
  - Note: `backend/test/fixtures/real-library-sample.json` — 999 images from the real-library spike, anonymised with `tools/immich-spike/anonymise-metadata.py` (labels: screenshot / photo / unknown). Hand-made edge cases (Android, macOS DE/FR, messenger JPEG, wallpaper, generated PNG, panorama, camera photo named "Screenshot…") live in `screenshot.job.spec.ts`.

- [x] **Deliverables:** a full dry run on your library returns scored candidates via API.
  - Note: verified via API against the throwaway Immich v3.3.5 (4 of 5 timeline images matched, thumbnails proxied) and in e2e tests on the real-library sample served by a fake Immich.

- [x] **Tests:** each signal and the threshold on fixtures.
  - Note: real-library sample at default params: 96/96 tagged screenshots matched (1.0), 0/679 camera photos, 1/224 others (887×1774 PNG, 0.6). Known false positive by design: a screen-sized PNG without tag (e.g. wallpaper) scores 0.6. e2e: review flow, tick/untick, thumbnail guard, 30k-asset dry run (~0.7 s against the fake).

- [ ] **Done when:** a dry run over 30k assets finishes and the top candidates look right when spot-checked in Immich.
  - Note: 30k simulated (29,970 assets, 30 pages); still to run against the real library.

---

### Phase 4 – Frontend

**Goal:** everything from phases 2–3 usable in the browser. **Milestone M1.**

**Status:** done (2026-11-03) – verified against a throwaway Immich v3.3.5 and in Playwright against the real backend with 2,910 candidates

Tasks:

- [x] App shell: Material toolbar, routes (`/jobs`, `/jobs/:id`, `/runs/:id`, `/settings`), HTTP interceptor for errors (field errors, snackbar, retry).
  - Note: also `/jobs/new`. Pages are lazy-loaded; Formly is provided on the job-editor routes only (initial bundle 635 kB raw / 142 kB transferred; budget warning raised to 750 kB). The interceptor passes `400 { errors[] }` through to the form (shown on the matching field, incl. generated params), shows the server message for other 4xx, and offers **Retry** (re-sends the request) for network errors and 5xx. Toolbar shows the Immich status (health polled every 30 s).
- [x] Dashboard: Immich status, job list with last run and status chip, buttons "Run now" / "Dry run".
  - Note: "Run now" is disabled for jobs in dry-run sync mode (tooltip explains); empty state with "Create a job".
- [x] Job editor: job type select, albums, sync mode, cron input, params form generated with ngx-formly (Material theme) from JSON Schema.
  - Note: ngx-formly 11 (`FormlyJsonschema`); custom field types for string lists (chips), booleans (plain toggle) and nested objects; labels humanised from keys, descriptions from the Zod schema. Server field errors land on the field (e.g. invalid cron). Also: delete (confirmation), recent runs, start runs from the editor.
- [x] Run detail: progress bar, live log via SSE (`EventSource`), totals, cancel/resume.
  - Note: indeterminate progress (Immich gives no library total, API notes §4.1), live totals and duration, log with live lines merged, error card (incl. Immich correlation id). The page reloads the authoritative run/log when the run ends.
- [x] Review grid (dry runs): CDK virtual scroll, lazy thumbnails, score badge, reasons, checkbox, score-band chips, sort.
  - Note: rows of cards (column count from the width); all candidates of the current filter are loaded in pages of 1,000; chips All / Score ≥ 0.8 / Below 0.8 / Unticked with counts; sort by score or name; tick/untick (optimistic, reverted on error) and "Tick all / Untick all" for the current filter. Native checkboxes instead of `mat-checkbox` (half the DOM per card).
- [x] Confirmation dialogs for destructive actions (placeholder until phase 5).
  - Note: delete job and switching to mirror mode ask for confirmation; "Apply to album" shows an info dialog until phase 5.
- [x] Build into backend `/public`; `ServeStaticModule` with SPA fallback.
  - Note: `PUBLIC_DIR` (default `public`, as in the Docker image); skipped with a warning when missing (development). `/api/*` excluded, so unknown API paths stay JSON 404s. `ng serve` proxies `/api` (`proxy.conf.json`).

- [x] **Deliverables:** create a screenshot job, run a dry run, review it in the grid.

- [x] **Tests:** component tests for review grid and generated form; one Playwright smoke test (create job → dry run → grid shows items).
  - Note: Vitest component tests (22): review grid (paging, chips, filter/sort reloads, toggle + revert, bulk), generated form (schema → field types, rendering, model binding, limits), error interceptor (validation pass-through, retry), SSE wrapper, shell. Playwright (`frontend/e2e`, CI job `ui-e2e`): real backend + production build + fake Immich serving 30× the anonymised real-library sample → 29,970 assets, 2,910 candidates; plus a server field-error test.

- [x] **Done when:** the review grid scrolls smoothly through several thousand candidates.
  - Note: Playwright scrolls all 2,910 candidates (863 frames at 150 px/frame ≈ 9,000 px/s): average 16.7 ms per frame (60 fps), p95 ≈ 23–26 ms, ≤ 200 cards in the DOM; asserted in CI (avg < 33 ms). The test serves raster (PNG) thumbnails like Immich's; SVG thumbnails rasterise on the main thread and were the only cause of dropped frames.

---

### Phase 5 – Album sync

**Goal:** real changes in Immich. **Milestone M2: screenshot album filled.**

**Status:** done (2026-11-03) – verified against a real throwaway Immich v3.3.5 (contract tests); pending: first real run on the real library

Tasks:

- [x] `AlbumSyncService`: resolve/create target and exclusion albums; compute `toAdd = matches − members − excluded`; mirror: `toRemove = owned − matches`.
  - Note: albums are found by exact name among the key owner's albums and created on real runs/apply only (dry runs and the apply preview never change Immich; `ImmichClient.findAlbum` added). Resolved ids are stored on the job. Excluded assets are dropped from **all** runs, dry runs included (no longer counted as matches). Mirror also drops ownership of owned assets the user removed by hand. The API rejects an exclusion album equal to the target.
- [x] Write in chunks of 500; record `job_asset` ownership rows per successful id.
  - Note: each page's new matches are written to Immich *before* the page's cursor is saved, and ownership + totals + cursor go in one SQLite transaction. So a resumed run can never skip unwritten matches; the cost is ≤ one add call per page with new matches (~30 on a first 30k run instead of ~6), and zero on reruns. `duplicate`/`not_found` count as already done; refusals (`no_permission`) are logged and counted.
- [x] Sync modes `additive` and `mirror` in the runner (real runs).
  - Note: mirror removals happen only after a complete run that was **not resumed** (a resumed run doesn't know the matches of earlier pages → removals skipped with a warning) and not incremental (phase 7). Run log ends with added / removed / already in album / excluded / refused.
- [x] Real runs store totals only, no `run_candidate` rows.
- [x] `POST /runs/:id/apply` for dry runs (selected candidates only).
  - Note: plus `GET /runs/:id/apply-preview` (read-only counts: selected, already in album, excluded, to add, album exists). Apply never removes, records ownership with `added_by_run_id` = the dry run, sets `job_run.applied_at` (migration `RunAppliedAt`) and is idempotent. 409 for real/unfinished runs or while the job has an active run; an in-process `JobLocks` keeps apply and runs of the same job apart.
- [x] UI: "Apply to album" with confirmation dialog showing counts; mirror-mode save confirmation.
  - Note: dialog shows "N assets will be added to "X" (new album)", already-in-album / excluded counts and "Nothing is removed"; snackbar with the result; run page shows added (and applied time) afterwards.

- [x] **Deliverables:** screenshots album in Immich, filled by an applied dry run or an additive run.
  - Note: verified against a real Immich v3.3.5 (contract tests) and in the UI (Playwright: apply 2,909 of 2,910, then an additive run adds the remaining 1).

- [x] **Tests:** sync diff (additive, mirror, ownership, exclusion, idempotent rerun = zero writes); contract test against a throwaway Immich v3 in CI.
  - Note: runner tests with an in-memory Immich (additive, idempotent rerun with zero writes, exclusion in real and dry runs, mirror keeps hand-added assets, additive never removes, resumed mirror skips removals, dry runs create nothing); API e2e on the real-library sample against a stateful fake Immich (incl. apply/preview/409s); contract tests (`npm run test:contract`, CI job `immich-contract` with Immich v3.3.5 in Docker, seeded via `tools/immich-spike`).

- [x] **Done when:** a second run without library changes makes zero album write calls; moving an asset to the exclusion album keeps it out after the next run.
  - Note: asserted in e2e (counting album write calls) and in the contract test against a real Immich (rerun adds 0; an asset moved to the exclusion album stays out; mirror removes an owned non-match).

---

### Phase 6 – iOS tag, feature cache, CLIP, scale

**Goal:** high accuracy on iPhone screenshots without heavy I/O.

**Status:** done (2026-11-03) – verified against a real throwaway Immich v3.3.5 and a 100k-asset scale test; pending: first run on the real library

Tasks:

- [x] `AssetFeatureCache` service over `asset_feature` (lookup by `asset_id` + `checksum`).
  - Note: `src/features/`; batched `getMany`/`setMany` (synchronous SQLite transaction); a changed checksum is a miss; assets without a checksum are never cached. Passed to job types as `JobContext.features`.
- [x] `fileTagScorer`: `readOriginalHead` with `Range: bytes=0-65535` (or stream-and-abort, per phase 0 result), parse with `exifr`, detect `UserComment = "Screenshot"`.
  - Note: implemented as the block `lookupIosScreenshotTags` (`src/core/blocks/file-tag.ts`): cache first, then a 64 KiB read; decodes UserComment's charset prefix (ASCII, UNICODE/UTF-16, undefined). Parse failures count as "no tag" and are cached (no endless re-reads); Immich errors are not cached and retried next run. A tagged asset is decisive (score 1.0, reason `ios-tag`).
- [x] Only read when needed: PNG or no camera EXIF, and not already ≥ threshold from metadata.
  - Note (phase 3): tagged iPhone screenshots already score 1.0 from the description tag, so reads are only needed for untagged borderline assets.
  - Note: on the real-library sample that is ~22 % of images on the first run (mostly camera-less JPEGs from messengers and generated PNGs), 0 afterwards.
- [x] File reads limited by `MAX_FILE_READS`; totals `files_read`, `cache_hits`.
  - Note: the run log ends with "iOS tag: N files read, M from cache"; the run page shows both totals.
- [x] `smartSource` + `rankScorer` for optional CLIP queries; rank map built once per run.
  - Note: best rank across queries; bonus `0.25 × (1 − rank/topN)`; Immich ML unavailable → warning, run continues without CLIP. Still off by default.
- [x] Enable `readIosTag` by default.
  - Note: screenshot job type bumped to **version 2** (forces a full rescan once phase 7 lands).
- [x] Scale test with a fake Immich serving 100k assets and sample PNGs: memory, runtime, read count.
  - Note: `npm run test:scale` (CI job `scale`): 99,900 assets (100× the anonymised sample) with sample originals. First run 22,300 files read in ~48 s; second run **0 files read** (22,300 cache hits) in ~1.4 s; a third run after all checksums changed reads everything again. Retained heap after each run ≈ 0. The test found two memory issues, both fixed: `exifr` caches options per options object (a fresh literal per read leaked ~8 KB → one shared options object), and long-lived run signals passed straight to `fetch` accumulate undici abort listeners (→ per-request linked signals, `linkSignal` in `ImmichClient`).

- [x] **Deliverables:** iOS screenshots named `IMG_xxxx.PNG` reliably land in the album.
  - Note: via the metadata description tag (96/96 in the real sample) and, when that is missing, the file tag (contract test: a PNG with only the EXIF tag is found through a real Immich original).

- [x] **Tests:** sample PNGs with and without the tag, a re-encoded screenshot (tag missing), cache hit on second run.
  - Note: fixtures in `backend/test/fixtures/files/` (ASCII/UTF-16 PNG tags, JPEG tag, no tag, re-encoded JPEG, other comment); unit tests for decoding, cache (checksum invalidation, chunking), read selection, CLIP; e2e (file-tagged asset found, borderline-only Range reads, second run 0 reads, checksum change → 1 re-read); contract test against a real Immich.

- [ ] **Done when:** a second full run reads close to zero files (cache hits); a full run over 30k assets completes within an acceptable window on your hardware.
  - Note: second run reads 0 files (scale test, e2e, contract). 100k fake assets: ~48 s first run / ~1.4 s second run on the CI-like container; still to time a run on the real 30k library and hardware.

---

### Phase 7 – Scheduler and incremental runs

**Goal:** no manual interaction. **Milestone M3: fully automated.**

**Status:** done (2026-11-03) – verified with a real throwaway Immich v3.3.5 (contract test) and a cron-driven e2e test; pending: a nightly run on the real library

Tasks:

- [x] `SchedulerModule`: register enabled jobs' cron on boot and on job change, in `TZ`.
  - Note: `JobScheduler` uses the `cron` package directly (already a dependency for validation) instead of `@nestjs/schedule`; jobs are (re-)registered on create/update and removed on delete/disable. The API rejects an enabled schedule without a cron expression. Job responses include `nextRunAt`.
- [x] Incremental mode: `since = started_at` of the last successful run; `updatedAfter` filter.
  - Note (phase 5): mirror removals are skipped on incremental runs (they need all matches); only full rescans remove.
  - Note: `RunLauncher` (shared by API and scheduler) plans each run: **real** runs are incremental since the start of the last *successful real* run; dry runs always scan everything (the review needs all candidates); the first real run is full. `job_run.full_rescan` now means "this run scans the whole library", `job_run.since` holds the incremental start. Verified against a real Immich: a screenshot uploaded after a run is picked up by the next incremental run.
- [x] Forced full rescan when a job type's `version` changes or the user clicks "Full rescan".
  - Note: a completed full real run stores the type version on the job (`job.type_version`); a mismatch forces the next run to be full (so the screenshot job's v2 from phase 6 triggers one full rescan). UI: "Full rescan" button in the job editor; `POST /jobs/:id/runs { fullRescan: true }`.
- [x] Skip a scheduled trigger if the job is already running.
  - Note: also skipped while a dry run of the job is being applied; logged as a warning.
- [x] Nightly housekeeping: prune candidates (keep last 5 dry runs per job), logs older than 30 days, `VACUUM` monthly.
  - Note: daily at 04:17 (`TZ`); retention from the `setting` table with defaults (`retention.dryRunCandidates` 5, `retention.logDays` 30; editable in phase 8); run history, ownership and the feature cache are never pruned; VACUUM every 30 days and only when no run is active.
- [x] Dashboard: next run time, last run summary.
  - Note: also in the job editor; the run page shows "full scan" / "incremental since …" and "scheduled".

- [x] **Deliverables:** nightly runs keep the album current.

- [x] **Tests:** scheduler registration on job change; incremental run only touches updated assets (fake clock).
  - Note: unit (scheduler registration, next run in `TZ`, skip when busy, run planning, type-version baseline, housekeeping incl. settings); e2e (incremental run scans 1 of 1,000 assets and sends `filter.updatedAt.gt`; `nextRunAt` follows job changes; a real cron firing every second fills the album and then picks up a new upload); contract test against a real Immich (upload via a separate upload-only key → incremental run adds it).

- [ ] **Done when:** a new screenshot uploaded during the day is in the album after the next scheduled run.
  - Note: shown end to end with a scheduled job (e2e) and with a real Immich (contract test, incremental run); still to observe a nightly run on the real library.

---

### Phase 8 – Hardening, auth, packaging

**Goal:** a stable v1.0 you can leave running. **Release v1.0.**

**Status:** done (2026-11-03) – version 1.0.0; pending: push the `v1.0.0` tag (publishes the image)

Tasks:

- [x] `AuthModule`: password login with session cookie (`httpOnly`, `SameSite=Strict`), `AUTH_MODE=forward-auth` to disable.
  - Note: stateless signed session cookie (30 days, `Secure` behind HTTPS); the signing key is derived from `APP_PASSWORD` (HKDF), so nothing secret is stored and a password change signs everyone out. Global guard on `/api` except `/health` and `/auth/*`; `/health` only returns `status`/`version` without a session. Failed logins per client are limited (10 per 15 min → 429). UI: login page, route guard, 401 → login, sign-out button.
- [x] Settings page: connection test, Immich version, retention, defaults; export/import jobs as JSON (`/jobs/export`, `/jobs/import`).
  - Note: `GET/PATCH /settings` (retention `retention.dryRunCandidates` / `retention.logDays`, `defaults.threshold` used for new jobs) plus read-only app facts (version, auth mode, TZ, limits, Immich URL). Import validates each job like `POST /jobs`, skips existing names and reports invalid entries; imported schedules are registered.
- [x] Thumbnail proxy restriction verified; container runs as `node`, read-only root filesystem tested.
  - Note: proxy guard covered by e2e (unknown asset → 404, Immich not asked; needs a session). CI smoke test runs the image with `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges`, signs in and writes a job.
- [x] Final Dockerfile and `docker-compose.yml`, `.env.example`, healthcheck.
  - Note: OCI labels, `VOLUME /data`, healthcheck intervals; compose: `read_only`, `tmpfs /tmp`, `init`, `cap_drop: ALL`, `no-new-privileges`, image `ghcr.io/gausim/immich-job-manager` with `build: .` fallback, `IMMICH_NETWORK` / `IMMICH_ALBUM_JOBS_VERSION` variables.
- [x] README: setup, API key creation and permissions, network name check, backup (`sqlite3 app.db ".backup ..."`), upgrade.
  - Note: rewritten around a 6-step setup, first album walkthrough, sign-in modes, backup/upgrade, hardening, configuration and API reference.
- [ ] Tag image `v1.0.0`.
  - Note: versions are 1.0.0 and `.github/workflows/release.yml` builds and pushes `ghcr.io/gausim/immich-job-manager:{1.0.0,1.0,latest}` (amd64 + arm64) on a `v*` tag; pushing the tag is left to the maintainer.

- [x] **Deliverables:** documented, password-protected v1.0 image.

- [x] **Done when:** a fresh setup from the README works end to end in under 15 minutes.
  - Note: followed the README in a clean directory against a real (throwaway) Immich v3.3.5: secrets with `600` permissions, hardened container healthy, sign in, "Immich connected", screenshot job, dry run (6 scanned / 5 matched), Apply → album `Screenshots` with 5 assets in Immich, additive + nightly schedule. Scripted UI part ≈ 25 s; with key creation and the image build (~3 min) roughly 10 minutes.

---

### Phase 9 – Python worker (optional, later)

**Goal:** custom ML for job types Immich cannot cover.

**Status:** not started

Tasks:

- [ ] `worker-py/`: FastAPI, `POST /score`, `GET /health`, own read-only API key, thumbnail fetching with a concurrency limit.
- [ ] `remoteScorer` block in the backend; job types using it are disabled when `PY_WORKER_URL` is unset.
- [ ] Compose profile `ml`.
- [ ] First ML job type, chosen when needed.

- [ ] **Done when:** a job type using `remoteScorer` runs end to end with `docker compose --profile ml up -d`.

---

## 3. Definition of done (every phase)

- [ ] Code merged with lint and tests green in CI.
- [ ] New config documented in `.env.example` and README.
- [ ] Migrations generated and tested on a copy of the current DB.
- [ ] Docker image builds and starts with `docker compose up -d`.
- [ ] Manually verified against your real Immich instance (dry run first).

---

## 4. Risks and mitigations

| Risk | Impact | Mitigation | Phase |
| --- | --- | --- | --- |
| Immich API changes in a minor release | Jobs fail | SDK pinned, version check on boot, contract tests in CI | 1, 5 |
| No HTTP Range support on originals | High I/O on first run | Stream-and-abort fallback, read only borderline assets, cache | 0, 6 |
| False positives (exported graphics, wallpapers) | Wrong assets in album | Dry-run review, threshold tuning, exclusion album | 3, 5 |
| Mirror mode removes wanted assets | Data loss in album | Only owned assets removed, confirmation, additive is default | 5 |
| Long first full run | Immich slowed down | Concurrency limits, resume on failure, run at night | 2, 6, 7 |
| SQLite lock contention | Run errors | WAL mode, one transaction per page, low concurrency | 1, 2 |

---

## 5. Next job types after v1.0 (backlog)

| Job type | Main signals | Python needed |
| --- | --- | --- |
| Documents and receipts | CLIP queries, no camera EXIF, OCR text (if exposed by Immich) | No |
| Messenger images | Filename patterns (e.g. WhatsApp), stripped EXIF | No |
| Best of a person per year | Metadata search by person + date, rating | No |
| Custom classifier | Model-specific | Yes (phase 9) |
