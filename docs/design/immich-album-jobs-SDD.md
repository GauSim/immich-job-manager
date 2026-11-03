# Immich Album Jobs – Software Design Document

| | |
| --- | --- |
| Version | 1.0 |
| Date | 2026-11-03 |
| Owner | Simon |
| Status | Draft for implementation |
| Target platform | Immich v3.x, Docker Compose |

---

## 1. Purpose and scope

Immich Album Jobs is a self-hosted companion app for Immich. It runs rerunnable **batch jobs** against an Immich library and syncs their results into Immich albums. The first job finds all screenshots in a library of 30,000+ assets and keeps them in one album.

### 1.1 Goals

- Define, run, rerun and schedule batch jobs that select assets and sync them into a target album.
- Process large libraries (30k+ assets, designed for 100k+) fully automated, with resumable and incremental runs.
- Offer a dry-run preview to tune a job before it changes anything.
- Add new job types in code (TypeScript first, Python only when needed) without touching the core.
- Talk to Immich only through its public REST API, authenticated with an API key.
- Ship as one Docker image, started with `docker compose up -d`.

### 1.2 Non-goals (v1)

- No direct access to the Immich Postgres database or upload folder.
- No deletion or modification of assets. Jobs only create albums and add or remove album membership.
- No multi-user tenancy: one app instance serves one Immich user (one API key).
- No end-user job builder. Job logic is code; job instances are configured in the UI.
- No Postgres. SQLite is sufficient; see section 13 for when to revisit.

### 1.3 Terms

| Term | Meaning |
| --- | --- |
| Job type | A code plugin that knows how to select assets, e.g. `screenshot-detector`. |
| Job | A configured instance of a job type: parameters, target album, sync mode, schedule. |
| Run | One execution of a job, with progress, logs and totals. |
| Dry run | A run that computes candidates and changes nothing; used to preview and tune. |
| Candidate | An asset a job returned, with a score (0..1) and the reasons for it. |
| Owned asset | An asset this app added to an album; only owned assets can ever be removed. |

---

## 2. Architecture overview

A single container is enough. NestJS serves the Angular build, exposes the REST API, runs jobs in-process and stores state in SQLite. It reaches Immich over the existing Docker network. A second container is only added later for Python ML, behind a Compose profile.

```text
                 ┌──────────────── Docker container: immich-album-jobs ────────────────┐
┌───────────┐ UI │ ┌──────────────────────────────────────────────────────────────────┐ │
│  Browser  │───►│ │ Angular SPA (static build, served from /public)                   │ │
│           │    │ └──────────────────────────────────────────────────────────────────┘ │
│           │REST│ ┌──────────────────────────────────────────────────────────────────┐ │
│           │SSE►│ │ NestJS REST API + SSE  (/api/*, thumbnail proxy)                  │ │
└───────────┘    │ └──────────────────────────────────────────────────────────────────┘ │
                 │ ┌──────────────────────────────────────────────────────────────────┐ │  HTTP   ┌───────────────┐
                 │ │ Runner + scheduler (queue, cron, album sync, dry run)            │─┼ - - - ►│ Python worker │
                 │ └──────────────────────────────────────────────────────────────────┘ │ (later) │ optional (ml) │
                 │ ┌───────────────────────────┐  ┌───────────────────────────────────┐ │         └───────┬───────┘
                 │ │ Job type plugins          │  │ SQLite (/data) via TypeORM        │ │                 │ thumbnails
                 │ │ screenshot + future       │  │ jobs, runs, owned ids, cache      │ │                 ▼
                 │ └───────────────────────────┘  └───────────────────────────────────┘ │         ┌───────────────┐
                 │ ┌──────────────────────────────────────────────────────────────────┐ │ API key │ Immich server │
                 │ │ ImmichClient adapter (@immich/sdk, retries, chunking, versions)  │─┼────────►│ REST API v3   │
                 │ └──────────────────────────────────────────────────────────────────┘ │         └───────────────┘
                 └──────────────────────────────────────────────────────────────────────┘
```

The browser only talks to this app. Only the backend holds the Immich API key. Job type plugins are the extension point: new album logic is a new folder of TypeScript.

### 2.1 Technology choices

| Layer | Choice | Reason |
| --- | --- | --- |
| Frontend | Angular (standalone components, signals) + Angular Material + CDK | Official, stable; inputs, errors, dialogs, snackbars, tables and virtual scroll out of the box. |
| Backend | NestJS on Node 22 | DI, modules, scheduler and discovery fit a plugin registry. |
| ORM | TypeORM via `@nestjs/typeorm` | Official Nest integration, DI repositories, generated migrations. |
| Database | SQLite (`better-sqlite3`, WAL mode) | One file in a volume; no extra container; ample for one user. |
| Immich access | `@immich/sdk`, wrapped in one adapter | Typed calls; one place to absorb API changes. |
| Queue | In-process | One user, few concurrent runs; BullMQ + Redis only if scaling out. |
| Forms | `zod-to-json-schema` + ngx-formly (Material theme) | Job parameter forms are generated; no frontend code per job type. |
| ML (later) | Python FastAPI container | Only for models Immich does not already provide. |

---

## 3. Run modes and operating model

The UI is for configuration, preview and monitoring. Real runs are fully automated.

| Mode | Trigger | What happens | What the UI shows |
| --- | --- | --- | --- |
| Dry run | "Dry run" button | Computes candidates, stores them per asset, changes nothing. | Review grid: score, reasons, untick false positives, "Apply to album". |
| Full run | "Run now" with "full rescan", or a job-type version bump | Scans the whole library, syncs the album. | Progress, live log, totals. |
| Incremental run | Cron schedule (e.g. nightly) or "Run now" | Scans only assets updated since the last successful run, syncs the album. | Progress, live log, totals. |
| Apply | "Apply to album" on a dry run | Syncs the selected candidates of that dry run. | Totals. |

Typical lifecycle of a new job:

1. Create the job in dry-run mode and run a full dry run.
2. Tune threshold and parameters in the review grid until results look clean.
3. Apply the dry run, or switch the job to `additive` and run it.
4. Enable the schedule. From then on, nightly incremental runs keep the album current with no interaction.

---

## 4. Job model and extension concept

Every job is a pipeline: **source → scorer(s) → decision → album sync**. Source, scorers and decision are job-type specific; album sync is shared core code.

```typescript
// core/job-type.ts
export interface JobType<P> {
  id: string;                         // 'screenshot-detector'
  name: string;                       // shown in the UI
  version: number;                    // bump when scoring logic changes -> forces full rescan
  params: z.ZodType<P>;               // validated config; JSON Schema generated for the UI
  defaultParams: P;
  select(ctx: JobContext<P>): AsyncIterable<CandidateBatch>;
}

export interface Candidate {
  assetId: string;
  score: number;                      // 0..1
  reasons: string[];                  // e.g. ['ios-tag', 'png']
}

export interface CandidateBatch {
  candidates: Candidate[];            // matched assets of this page
  scanned: number;                    // assets looked at in this page
  cursor: string;                     // resume point after this page
}

export interface JobContext<P> {
  params: P;
  immich: ImmichClient;               // typed adapter, never raw fetch
  since?: Date;                       // set for incremental runs
  resumeFrom?: string;                // cursor of an interrupted run
  features: AssetFeatureCache;        // per-asset cache (section 7)
  log: RunLogger;
  signal: AbortSignal;                // cancellation
}
```

```typescript
// jobs/screenshot/screenshot.job.ts
@AlbumJobType()
export class ScreenshotJob implements JobType<ScreenshotParams> { /* see section 6 */ }
```

Job types yield results **page by page**. The runner persists each batch and its cursor in one transaction before asking for the next page, so memory stays flat and an interrupted run resumes where it stopped.

### 4.1 Reusable building blocks (`core/blocks/`)

| Block | Kind | What it does |
| --- | --- | --- |
| `metadataSource(filter)` | source | Pages through `POST /search/metadata` with any Immich filter. |
| `smartSource(query, limit)` | source | CLIP search via `POST /search/smart`; returns ranked assets. |
| `albumSource(albumId)` | source | Current members of an album (exclusion, chaining). |
| `filenameScorer(patterns)` | scorer | Regex on `originalFileName`. |
| `exifScorer(rules)` | scorer | Rules on make, model, lens, dimensions, MIME type. |
| `rankScorer(rankMap)` | scorer | Turns a CLIP rank into a 0..1 score. |
| `fileTagScorer(tag, value)` | scorer | Reads an EXIF tag from the original file, cached (section 6.2). |
| `remoteScorer(url)` | scorer | Sends asset ids to the Python worker, receives scores (later). |

### 4.2 Sync modes (per job)

- `dry-run` (default for new jobs): compute candidates, change nothing.
- `additive`: add new matches, never remove.
- `mirror`: add new matches and remove **owned** assets that no longer match. Assets added by hand are never removed.

### 4.3 User corrections

Each job has an exclusion album (default `<target> – excluded`). Moving a false positive there, from the Immich app or web, keeps it out of all future runs.

### 4.4 Python, only when needed

The Python worker is a separate FastAPI container with one contract:
`POST /score {jobType, params, assetIds[]} → [{assetId, score, reasons}]`.
It pulls thumbnails from Immich itself with its own read-only API key. The core never imports Python and runs fine without it.

---

## 5. Immich API integration

Target **Immich v3.x only**, through `@immich/sdk` pinned to the server's major version, wrapped in one `ImmichClient` adapter. Immich v3 (1 July 2026) changed and removed endpoints used by third-party tools, so the adapter is the only place that knows endpoint shapes.

### 5.1 Authentication

- One API key sent as `x-api-key`, read from a Docker secret file.
- Scoped key: asset read, asset download (originals for the iOS tag), album read/create, album-asset add/remove. Verify exact permission names in the Immich key dialog.
- The key never reaches the database or the browser.

### 5.2 Endpoints used

| Purpose | Endpoint | Notes |
| --- | --- | --- |
| Version check at startup | `GET /server/about` | Refuse to run jobs if major ≠ 3. |
| Enumerate the library | `POST /search/metadata` | Cursor-paged (`filter` DSL + `cursor`; `page` is deprecated in v3.3, see API notes). Filters: `type`, `updatedAt`, `albumIds`, `visibility`; `withExif`. |
| Semantic signal | `POST /search/smart` | CLIP text query; requires Immich ML. |
| Find or create albums | `GET /albums`, `POST /albums` | v3: `isShared`, `isOwned` query params. |
| Read album members | `POST /search/metadata` with `albumIds` | v3 removed `assets` from album responses. |
| Add to album | `PUT /albums/{id}/assets` | Bulk ids, per-id result. |
| Remove from album | `DELETE /albums/{id}/assets` | Mirror mode, owned assets only. |
| Read iOS screenshot tag | `GET /assets/{id}/original` | Partial read; see 6.2. |
| Thumbnails | `GET /assets/{id}/thumbnail` | Proxied by the backend for the UI. |

### 5.3 v3 details the adapter must handle

- Search endpoints default to any visibility (archived included, locked excluded) when `visibility` is omitted. The adapter always sets it explicitly from job params.
- Validation errors use `{ message, errors[] }`; the correlation id is in the `X-Correlation-ID` response header. Log it on every failure.
- v3 deprecates `PUT` routes in favour of `PATCH`. Going through the SDK keeps this a version bump.

### 5.4 Throughput and safety

| Setting | Value |
| --- | --- |
| Metadata search page size | 1,000 |
| Album write chunk size | 500 ids |
| Concurrent metadata/album requests | 2 |
| Concurrent original-file reads | 4 (separate limit) |
| Retries | 3, exponential backoff on 429 and 5xx |
| On final failure | Run fails with a saved cursor; "Resume" continues from it |

Album sync is idempotent: `toAdd = matches − members − excluded`, `toRemove = owned − matches` (mirror only). A rerun with no library changes makes zero write calls.

### 5.5 Overlap with Immich Workflows

Immich v3 ships Workflows as a preview (trigger, filters, actions). Simple rules may later move there. This app covers what Workflows don't: scored multi-signal logic, full-library backfills, dry-run review, and custom code or ML.

---

## 6. Use case 1: screenshot detector

Scope: **images only**. Videos (including screen recordings) are always skipped.

### 6.1 Signals

| Signal | Rule | Score |
| --- | --- | --- |
| iOS description tag | Immich `exifInfo.description = "Screenshot"` (from the metadata; verified on the real library, see API notes §4.2) | sets score to 1.0 |
| iOS screenshot tag | EXIF `UserComment = "Screenshot"` in the original file | sets score to 1.0 |
| Filename | `originalFileName` matches `Screenshot`, `Screen Shot`, `Bildschirmfoto`, `Capture d’écran`, `Schermafbeelding`, `Screenshot_` | +0.6 |
| Format | MIME `image/png` | +0.25 |
| No camera EXIF | `make`, `model`, `lensModel`, `exposureTime`, `fNumber` all empty | +0.15 |
| Screen dimensions | width × height in a configurable list of device resolutions, or aspect ratio ≥ 2.0 with no camera EXIF | +0.2 |
| CLIP rank | asset in the top N of `/search/smart` for configured queries | +0.25 × rank factor |

Scores are summed and capped at 1.0. Default threshold: 0.6. Every candidate keeps its reasons.

### 6.2 iOS screenshot tag

iOS and macOS write EXIF `UserComment = "Screenshot"` into every screenshot; Apple Photos uses this tag for its Screenshots album. Immich does not store `UserComment` (its description comes only from `ImageDescription` and `Description`), so the job reads the tag from the original file.

> Update (phase 3): on the real library Immich's `description` of iPhone screenshots *is* `"Screenshot"`, so most screenshots are already decisive from metadata (iOS description tag above). The file read below remains the fallback for untagged borderline assets.



- **Only when needed:** for PNGs or assets without camera EXIF that don't already pass the threshold on metadata alone.
- **Partial read:** request only the first 64 KB with an HTTP `Range` header (to verify that Immich honours it on originals). Fallback: stream the file and abort as soon as the tag is parsed (`exifr` in Node).
- **Cached:** the result is stored per asset with its checksum in `asset_feature`. Each file is read once and re-read only when its checksum changes.
- **Limited:** max 4 concurrent reads, so Immich stays responsive.

The tag is lost when a screenshot was re-encoded (e.g. sent through a messenger), so the other signals remain as fallback.

### 6.3 Parameters

```typescript
type ScreenshotParams = {
  targetAlbum: string;                 // 'Screenshots'
  exclusionAlbum?: string;             // 'Screenshots – excluded'
  threshold: number;                   // 0.6
  filenamePatterns: string[];
  screenResolutions: [number, number][];
  readIosTag: boolean;                 // true
  clip: { enabled: boolean; queries: string[]; topN: number };  // topN 2000
  includeArchived: boolean;            // false
};
```

### 6.4 Run flow

1. Check Immich version and API key; resolve or create target and exclusion albums.
2. Load exclusion-album members and the job's owned assets.
3. If CLIP is enabled, run each smart-search query once and keep a rank map.
4. Page through `/search/metadata` (`type: IMAGE`, `withExif: true`, `updatedAfter` for incremental runs, `resumeFrom` cursor if resuming).
5. Per page: score metadata signals; for borderline assets, look up or read the iOS tag; drop excluded assets; keep score ≥ threshold.
6. Per page, in one transaction: persist candidates (dry run) or queue album adds (real run), plus totals and cursor.
7. Real run: flush album adds in chunks of 500; mirror mode then removes owned non-matches.
8. Store final totals: scanned, matched, added, removed, files read, cache hits, duration.

### 6.5 Expected cost for 30,000 assets

| Step | Cost |
| --- | --- |
| Metadata enumeration | ~30 API calls |
| Metadata scoring | in memory, negligible |
| CLIP queries | a few calls |
| iOS tag reads, first full run | only borderline PNGs; partial reads |
| iOS tag reads, later runs | only new or changed files (cache) |
| Album writes, e.g. 3,000 screenshots | ~6 calls |
| Nightly incremental run | assets updated since last run only |

---

## 7. Data model and persistence

SQLite file at `/data/app.db`, WAL mode, accessed through TypeORM (`better-sqlite3` driver). Generated migrations run at startup; `synchronize` is always off. JSON columns use `simple-json`. Immich remains the source of truth for assets and albums.

| Table | Key columns | Purpose |
| --- | --- | --- |
| `job` | `id`, `name`, `type_id`, `type_version`, `params`, `target_album_id`, `exclusion_album_id`, `sync_mode`, `schedule`, `enabled` | One configured job. |
| `job_run` | `id`, `job_id`, `status`, `trigger`, `dry_run`, `full_rescan`, `started_at`, `finished_at`, `since`, `cursor`, `scanned`, `matched`, `added`, `removed`, `files_read`, `cache_hits`, `error` | One execution; `cursor` makes it resumable. |
| `run_candidate` | `run_id`, `asset_id`, `score`, `reasons`, `selected` | **Dry runs only.** Review grid; `selected` for untick. |
| `job_asset` | `job_id`, `asset_id`, `added_by_run_id`, `added_at` | Ownership; mirror mode only removes rows found here. |
| `asset_feature` | `asset_id`, `checksum`, `ios_screenshot_tag`, `checked_at` | Per-asset cache of expensive signals. |
| `run_log` | `run_id`, `ts`, `level`, `message` | Run log for the UI. |
| `setting` | `key`, `value` | Non-secret runtime settings. |

- `status`: `queued`, `running`, `succeeded`, `failed`, `cancelled`, `interrupted`. On startup, `running` becomes `interrupted`.
- Writes are batched: one transaction per page.
- Retention: candidates for the last 5 dry runs per job, logs for 30 days; nightly housekeeping prunes the rest.
- Indexes: `job_asset(job_id, asset_id)`, `run_candidate(run_id, score)`, `asset_feature(asset_id)`.

---

## 8. Backend (NestJS)

One process serves the API, runs jobs and serves the Angular build. The in-process `RunQueue` allows one run per job and `MAX_CONCURRENT_RUNS` overall (default 2).

### 8.1 Modules

| Module | Responsibility |
| --- | --- |
| `ConfigModule` | Env + secret files, validated with Zod at boot. |
| `PersistenceModule` | `@nestjs/typeorm`, entities, migrations, repositories. |
| `ImmichModule` | `ImmichClient`: version check, retries, chunking, concurrency limits, partial reads, thumbnail proxy. |
| `JobTypesModule` | Discovers `@AlbumJobType()` classes via `DiscoveryService`; exposes params as JSON Schema. |
| `RunnerModule` | `RunQueue`, `RunExecutor` (pipeline, cancellation, cursor, progress), `AlbumSyncService`, `AssetFeatureCache`. |
| `SchedulerModule` | `@nestjs/schedule`; registers each enabled job's cron, re-registers on change; nightly housekeeping. |
| `EventsModule` | SSE stream of run progress (throttled to 1 event/s) and log lines. |
| `AuthModule` | App password login, session cookie; can be disabled behind forward auth. |
| `ApiModule` | Controllers; DTOs validated with Zod. |
| `ServeStaticModule` | Serves `/public` with SPA fallback; `/api/*` excluded. |

### 8.2 Source layout

```text
backend/src/
  core/            job-type.ts, blocks/, album-sync.service.ts, feature-cache.service.ts
  immich/          immich.client.ts, immich.module.ts
  jobs/
    screenshot/    screenshot.job.ts, screenshot.params.ts, screenshot.job.spec.ts
  runner/  scheduler/  persistence/  api/  events/  auth/  config/
  main.ts
```

### 8.3 REST API (under `/api`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/job-types` | Job types with params JSON Schema and defaults. |
| GET, POST | `/jobs` | List or create jobs. |
| GET, PATCH, DELETE | `/jobs/:id` | Read, update, delete (never touches the album). |
| GET | `/jobs/export` | All jobs as JSON. |
| POST | `/jobs/import` | Import jobs from JSON. |
| POST | `/jobs/:id/runs` | Start a run: `{ dryRun, fullRescan }`. |
| GET | `/jobs/:id/runs` | Run history. |
| GET | `/runs/:id` | Run detail and totals. |
| POST | `/runs/:id/cancel` | Cancel. |
| POST | `/runs/:id/resume` | Resume an interrupted or failed run from its cursor. |
| GET | `/runs/:id/events` | SSE: progress, log lines, final status. |
| GET | `/runs/:id/candidates` | Dry run: paged candidates, sortable by score. |
| PATCH | `/runs/:id/candidates` | Dry run: tick/untick. |
| POST | `/runs/:id/apply` | Dry run: apply selected candidates. |
| GET | `/assets/:id/thumbnail` | Thumbnail proxy (only assets seen in a run). |
| GET, PATCH | `/settings` | Runtime settings. |
| GET | `/health` | Liveness, Immich reachability and version. |

---

## 9. Frontend (Angular)

Angular SPA with standalone components, signals and Angular Material + CDK, served by NestJS from the same origin (no CORS).

### 9.1 Pages

| Page | Shows | Key actions |
| --- | --- | --- |
| Dashboard | Immich status + version, jobs with last run, next scheduled run | Run now, dry run, enable/disable |
| Job editor | Job type, albums, sync mode, cron, generated params form | Save, validate, duplicate |
| Run detail | Progress bar, live log (SSE), totals, errors with correlation id | Cancel, resume |
| Review grid (dry runs) | Thumbnail cards with score and reasons, score-band filters | Untick, apply to album |
| Settings | Connection status, Immich version, retention, defaults | Test connection, export/import jobs |

### 9.2 Review grid wireframe

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Immich Album Jobs     Jobs   Runs   Settings                ● Immich connected │
├──────────────────────────────────────────────────────────────────────────────┤
│ Screenshots · dry run review                          [ Discard ] [ Apply ▸ ] │
│ Threshold 0.6 · target album Screenshots                                     │
│ (All) (Score ≥ 0.8) (0.6 to 0.8) (Unticked)              Sort: score ▾        │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                           │
│ │☑    1.0  │ │☑   0.85  │ │☑    1.0  │ │☑   0.85  │                           │
│ │  [thumb] │ │  [thumb] │ │  [thumb] │ │  [thumb] │                           │
│ │IMG_xxxx  │ │Screensh… │ │IMG_xxxx  │ │Bildschi… │                           │
│ │iOS tag   │ │filename  │ │iOS tag   │ │filename  │                           │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘                           │
│ ┌ ─ ─ ─ ─ ┐  ┌──────────┐ ...                                                │
│ │☐    0.6  │ │☑   0.85  │       (CDK virtual scroll, lazy thumbnails)        │
│ │unticked  │ │filename  │                                                    │
│ └ ─ ─ ─ ─ ┘  └──────────┘                                                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 9.3 UI library decision

| Library | Strengths | Trade-offs |
| --- | --- | --- |
| **Angular Material + CDK (chosen)** | Official, stable, accessible; `mat-error`, `MatDialog`, snackbars, tables, virtual scroll | Material look; styling via theme tokens |
| PrimeNG | Very large component set | Heavier; theming changed across majors |
| spartan/ui | shadcn-style on Tailwind | Younger; more assembly |

### 9.4 Error handling

One HTTP interceptor: validation errors (`errors[]` with field path) go to the matching form field, transient errors to a snackbar with retry, failed runs to the run detail page with the Immich correlation id. Destructive actions (apply, mirror-mode save, delete job) use a confirmation dialog.

---

## 10. Configuration

| Layer | What | Where | How to change |
| --- | --- | --- | --- |
| Bootstrap + secrets | Immich URL, API key, app password, port, data dir, time zone, run limit | `.env` (plain values), `./secrets/*` files | Edit, then `docker compose up -d` |
| Runtime settings | Retention, default threshold for new jobs, UI preferences | `setting` table | Settings page |
| Job definitions | Type, params, albums, sync mode, schedule | `job` table | Job editor; export/import JSON |

- The Immich URL and API key are **env-only in v1**; the Settings page shows status and a test button only.
- Precedence: env → database → built-in defaults. Validated with Zod at boot; invalid config stops the app with a clear message.

| Variable | Default | Meaning |
| --- | --- | --- |
| `IMMICH_URL` | – | Immich API base including `/api`. |
| `IMMICH_API_KEY_FILE` | – | Path to the API key secret (`IMMICH_API_KEY` accepted for dev). |
| `APP_PASSWORD_FILE` | – | App login password; omit only behind forward auth. |
| `AUTH_MODE` | `password` | `password` or `forward-auth`. |
| `PY_WORKER_URL` | unset | Enables `remoteScorer` jobs (later). |
| `DATA_DIR` | `/data` | SQLite location. |
| `MAX_CONCURRENT_RUNS` | `2` | Global run limit. |
| `MAX_FILE_READS` | `4` | Concurrent original-file reads. |
| `PORT` | `3000` | HTTP port. |
| `TZ` | `UTC` | Time zone for cron schedules. |

---

## 11. Deployment

### 11.1 Dockerfile

```dockerfile
# ---- frontend ----
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npx ng build --configuration production

# ---- backend ----
FROM node:22-bookworm-slim AS api
WORKDIR /api
COPY backend/package*.json ./
RUN npm ci
COPY backend/ .
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
WORKDIR /app
COPY --from=api /api/dist ./dist
COPY --from=api /api/node_modules ./node_modules
COPY --from=web /web/dist/frontend/browser ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
```

Debian slim, not Alpine, so `better-sqlite3` installs without native build issues.

### 11.2 docker-compose.yml

```yaml
services:
  album-jobs:
    build: .
    image: immich-album-jobs:latest
    container_name: immich_album_jobs
    restart: unless-stopped
    ports:
      - "3000:3000"
    env_file: .env
    environment:
      IMMICH_API_KEY_FILE: /run/secrets/immich_api_key
      APP_PASSWORD_FILE: /run/secrets/app_password
    volumes:
      - ./data:/data
    secrets: [immich_api_key, app_password]
    networks: [immich]

  # later, only with: docker compose --profile ml up -d
  py-worker:
    profiles: ["ml"]
    build: ./worker-py
    restart: unless-stopped
    environment:
      IMMICH_URL: http://immich_server:2283/api
      IMMICH_API_KEY_FILE: /run/secrets/immich_api_key_readonly
    secrets: [immich_api_key_readonly]
    networks: [immich]

networks:
  immich:
    external: true
    name: immich_default   # check with: docker network ls

secrets:
  immich_api_key:
    file: ./secrets/immich_api_key
  immich_api_key_readonly:
    file: ./secrets/immich_api_key_readonly
  app_password:
    file: ./secrets/app_password
```

```dotenv
# .env (non-secret values only)
IMMICH_URL=http://immich_server:2283/api
TZ=Europe/Berlin
MAX_CONCURRENT_RUNS=2
MAX_FILE_READS=4
```

```bash
mkdir -p secrets data && chmod 700 secrets
printf '%s' 'your-immich-api-key' > secrets/immich_api_key
printf '%s' 'your-app-password'   > secrets/app_password
docker compose up -d --build
```

---

## 12. Security, observability, testing

### 12.1 Security

- API key only in a Docker secret, only in the backend; scoped key without delete or admin rights.
- App login (single password, `httpOnly` + `SameSite=Strict` session cookie) or forward auth (Authelia, Authentik). Never exposed without one of them.
- Thumbnail proxy only serves assets that appeared in a run of this app.
- Container runs as `node`; only `/data` and `/tmp` writable.
- Safe defaults: new jobs start as dry run; mirror mode only removes owned assets; apply and mirror require confirmation.

### 12.2 Observability

- Structured JSON logs (pino) with `runId`, `jobId` and Immich's `X-Correlation-ID`.
- Run totals: scanned, matched, added, removed, files read, cache hits, API calls, duration.
- `/api/health` for the Docker healthcheck.

### 12.3 Testing

- Unit tests per job type with anonymised fixture assets (snapshots of real `/search/metadata` items) and sample PNGs with and without the iOS tag.
- `AlbumSyncService` tests: additive, mirror, ownership, exclusion, idempotent rerun.
- Runner tests: cursor resume, cancellation, batched transactions.
- Contract tests in CI against a throwaway Immich v3 stack seeded with screenshots and camera photos.
- Load test: a fake Immich returning 100k synthetic assets; assert flat memory and runtime.
- Angular component tests for the review grid and generated forms.

---

## 13. Decisions and open items

### 13.1 Decisions

| Decision | Choice |
| --- | --- |
| Containers | One app container; Python worker later, behind a profile |
| Database | SQLite; Postgres off the table for now |
| ORM | TypeORM |
| UI library | Angular Material + CDK |
| Immich versions | v3.x only |
| Screenshot scope | Images only; no screen recordings |
| Config | Env + secrets for connection; SQLite + UI for jobs and settings |
| Exclusion mechanism | Exclusion album in Immich |

### 13.2 Revisit Postgres only if

- several workers write at the same time (BullMQ, multiple instances),
- multi-user support is added, or
- run history needs heavy reporting.

### 13.3 Open items

Phase 0 spike results: [`docs/immich-api-notes.md`](../immich-api-notes.md) (verified on v3.3.5).

| Item | Owner | How to close | Status |
| --- | --- | --- | --- |
| Does Immich honour HTTP `Range` on `GET /assets/{id}/original`? | Simon | Test with `curl -r 0-65535` in phase 6; otherwise use stream-and-abort. | **Closed:** yes, `206 Partial Content`; 64 KiB is enough to parse `UserComment`. |
| Exact API key permission names for v3 | Simon | Check the Immich key dialog when creating the key. | **Closed:** `server.about`, `asset.read`, `asset.view`, `asset.download`, `album.read`, `album.create`, `albumAsset.create`, `albumAsset.delete`. |
| Is `withExif` returning `make`/`model`/`mimeType` in search results on v3.3? | Simon | Verify in phase 1 spike. | **Closed:** yes; MIME type is `originalMimeType` on the asset, not in `exifInfo`. |
| Simple rules via Immich Workflows | Later | Revisit when Workflows leave preview. | Open |

Also found: `page` on `POST /search/metadata` is deprecated in v3.3; use the `filter` DSL with `cursor` pagination (notes §4.1).

### 13.4 Sources

- [Immich v3 migration guide](https://immich.app/blog/v3-migration)
- [Immich v3.0.0 release notes](https://immich.app/blog/v3.0.0-release)
- [Immich API reference](https://api.immich.app/)
- [Apple Community: screenshot EXIF UserComment](https://discussions-jp-prz.apple.com/en/thread/255854599?page=1)
- [Immich EXIF tags reference](https://docs.pr-30460.preview.immich.app/reference/exif-tags)
