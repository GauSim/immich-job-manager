# Immich Album Jobs

Self-hosted companion app for [Immich](https://immich.app) v3: rerunnable, scheduled batch jobs that find assets and keep them in an Immich album. The first job type puts **all your screenshots** into one album. It talks to Immich only through its REST API, with a scoped API key, and never deletes or changes assets — it only creates albums and adds/removes album membership.

> **v1.0.0** – screenshot job, dry-run review in the browser, album sync (additive / mirror / exclusion album), nightly incremental runs, password login. Python ML jobs (phase 9) are not part of 1.0.

- Design: [software design document](docs/design/immich-album-jobs-SDD.md) · [implementation plan](docs/design/immich-album-jobs-implementation-plan.md) · [Immich API notes](docs/immich-api-notes.md)

---

## Setup (about 10 minutes)

**You need:** Immich **v3.x** running with Docker Compose, and Docker Compose v2 on the same host.

### 1. Create an Immich API key

In Immich: **Account settings → API keys → New API key**. Name it e.g. `album-jobs` and grant exactly these permissions (nothing else is needed — no delete, no admin):

| Permission | Used for |
| --- | --- |
| `server.about` | version check |
| `asset.read` | searching the library (metadata and smart search) |
| `asset.view` | thumbnails in the review grid |
| `asset.download` | reading the first 64 KB of borderline originals (iOS screenshot tag) |
| `album.read`, `album.create` | finding / creating the target and exclusion albums |
| `albumAsset.create` | adding matches to the album |
| `albumAsset.delete` | removing assets in *mirror* mode (only assets this app added) |

Copy the key; Immich shows it only once.

### 2. Get the files

```bash
git clone https://github.com/GauSim/immich-job-manager.git immich-album-jobs
cd immich-album-jobs
cp .env.example .env
```

Edit `.env`: set `IMMICH_URL` (the Immich server container name on its Docker network, with `/api`, usually `http://immich_server:2283/api`) and `TZ` (e.g. `Europe/Berlin`; schedules use it).

### 3. Secrets and data directory

```bash
mkdir -p secrets data
printf '%s' 'PASTE-THE-IMMICH-API-KEY' > secrets/immich_api_key
printf '%s' 'CHOOSE-AN-APP-PASSWORD'   > secrets/app_password
touch secrets/immich_api_key_readonly                 # placeholder for the optional ML worker
chmod 700 secrets && chmod 600 secrets/*
sudo chown -R 1000:1000 secrets data                  # the container runs as uid 1000 (node)
```

The secrets are mounted as Docker secrets; they never reach the database or the browser.

### 4. Check the Immich network name

```bash
docker network ls | grep immich
```

The default compose file joins `immich_default` (what Immich's own compose file creates). If yours differs, add `IMMICH_NETWORK=<name>` to `.env`.

### 5. Start

```bash
docker compose up -d --build        # builds the image from this checkout (~3 min)
```

Once a release image exists you can instead use `docker compose pull && docker compose up -d` (`ghcr.io/gausim/immich-job-manager`).

Open `http://<host>:3000`, sign in with the app password, and check the toolbar: **● Immich connected**. If not, **Settings → Test connection** shows the error (wrong URL, network, or key permissions).

### 6. Your first album

1. **Jobs → New job**: type *Screenshots*, name and target album `Screenshots`. Leave sync mode on **Dry run only** and save.
2. **Dry run** → the run page streams progress; when it finishes, review the candidates. Untick false positives.
3. **Apply to album** adds the ticked candidates (the album is created if needed).
4. Edit the job: sync mode **Additive**, schedule `0 3 * * *`, **Schedule enabled** → save. From now on, new screenshots land in the album every night (incremental runs only look at assets changed since the last run).

False positive later? Move it to the album **`Screenshots – excluded`** in Immich; it stays out from then on.

---

## How it works

### Screenshot detection

Per image (videos are skipped), signals add up to a score (0–1); the default threshold is 0.6:

| Signal | Score |
| --- | --- |
| Immich description is `Screenshot` (iOS writes it) | decisive (1.0) |
| iOS tag `UserComment = "Screenshot"` in the original file | decisive (1.0) |
| File name (`Screenshot`, `Bildschirmfoto`, `Capture d’écran`, …) | +0.6 |
| PNG | +0.25 |
| No camera EXIF | +0.15 |
| Screen-sized (known device resolution, or long/short ≥ 2 without camera EXIF) | +0.2 |
| CLIP smart search rank (optional, needs Immich ML) | up to +0.25 |

The file tag is only read for borderline images (PNG or no camera EXIF, below the threshold): the first 64 KB of the original, at most `MAX_FILE_READS` at a time, cached per asset and checksum — later runs read only new or changed files. All parameters are editable per job.

### Album sync

- **Dry run** (default for new jobs): computes and stores candidates, changes nothing in Immich. Review them, untick false positives, **Apply to album**.
- **Additive**: adds new matches, never removes.
- **Mirror**: adds new matches and removes assets *this app added* that no longer match (only after a complete full scan). Assets you add by hand are never removed.
- **Exclusion album** (default `<target> – excluded`): anything in it stays out.
- **Schedules** (cron, in `TZ`): real runs are **incremental** (assets updated since the last successful run); the first run, a job-type update and **Full rescan** scan everything; dry runs always scan everything. A scheduled run is skipped while the job is still running.
- **Housekeeping** (nightly): keeps candidates of the last 5 dry runs per job and 30 days of run logs (both adjustable in Settings); vacuums the database monthly.
- A rerun without library changes makes no write calls to Immich.

---

## Operations

### Sign-in

`AUTH_MODE=password` (default): one app password (`APP_PASSWORD_FILE`), session cookie (`httpOnly`, `SameSite=Strict`, `Secure` behind HTTPS) valid for 30 days; changing the password signs everyone out; repeated wrong passwords are slowed down.

Behind an authenticating reverse proxy (Authelia, Authentik, …) set `AUTH_MODE=forward-auth` and drop the `app_password` secret — the app then trusts every request, so **never expose it without the proxy**.

### Backup

Everything lives in `./data/app.db` (SQLite). Back it up while running (WAL-safe):

```bash
sqlite3 data/app.db ".backup data/app-$(date +%F).db"
```

or stop the container and copy `data/`. Job definitions alone: **Settings → Export** (JSON; **Import** on a new instance). Immich stays the source of truth for assets and albums.

### Upgrade

```bash
sqlite3 data/app.db ".backup data/app-before-upgrade.db"
git pull && docker compose up -d --build          # or: docker compose pull && docker compose up -d
```

Database migrations run automatically on start. Check `docker compose logs album-jobs` and the toolbar status afterwards.

### Health and logs

`GET /api/health` (used by the Docker healthcheck) answers `200` while the app and database are up — `status: degraded` if Immich is unreachable — and `503` if the database is down. Without a session it only returns `status` and `version`.

Logs are JSON (pino) on stdout: `docker compose logs -f album-jobs`. Each run's log is also on its run page.

### Hardening

The compose file runs the container as uid 1000 with a read-only root filesystem (`/data` and a `tmpfs` `/tmp` are the only writable paths), no Linux capabilities and `no-new-privileges`. The thumbnail proxy only serves assets that appeared in a run, so the API key can't be used to browse the library through the app.

---

## Configuration

All settings are environment variables, validated at start; an invalid value stops the app with a list of problems. See [`.env.example`](.env.example).

| Variable | Default | Meaning |
| --- | --- | --- |
| `IMMICH_URL` | – | Immich API base including `/api`, e.g. `http://immich_server:2283/api` |
| `IMMICH_API_KEY_FILE` | – | File with the Immich API key (Docker secret). `IMMICH_API_KEY` for development. |
| `APP_PASSWORD_FILE` | – | File with the app password. `APP_PASSWORD` for development. Not used with `AUTH_MODE=forward-auth`. |
| `AUTH_MODE` | `password` | `password` or `forward-auth` |
| `TZ` | `UTC` | Time zone for schedules |
| `MAX_CONCURRENT_RUNS` | `2` | Global run limit (one run per job) |
| `MAX_FILE_READS` | `4` | Concurrent original-file reads from Immich |
| `PORT` | `3000` | HTTP port inside the container |
| `DATA_DIR` | `/data` | SQLite location |
| `PUBLIC_DIR` | `public` | UI build served at `/` |
| `LOG_LEVEL` | `info` | `fatal` … `trace` |
| `IMMICH_NETWORK` | `immich_default` | (compose only) Immich's Docker network |
| `IMMICH_ALBUM_JOBS_VERSION` | `1.0.0` | (compose only) image tag to pull |
| `PY_WORKER_URL` | unset | Python ML worker (phase 9) |

Runtime settings (retention, default threshold) are in **Settings** and stored in the database.

---

## API

All under `/api`; every route except `/health` and `/auth/*` needs a session (or `AUTH_MODE=forward-auth`). Validation errors: `400 { message: "Validation failed", errors: [{ path, message }] }`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/login`, `/auth/logout` · GET `/auth/session` | Sign in `{ password }` / out; session state |
| GET | `/health` | Liveness, database, Immich |
| GET | `/job-types` | Job types with params JSON Schema and defaults |
| GET, POST | `/jobs` | List (incl. last run, next scheduled run) / create |
| GET, PATCH, DELETE | `/jobs/:id` | Read / update / delete (never touches Immich albums) |
| GET · POST | `/jobs/export` · `/jobs/import` | Job definitions as JSON |
| POST | `/jobs/:id/runs` | Start a run `{ dryRun?, fullRescan? }` (409 if one is active) |
| GET | `/jobs/:id/runs` | Run history (`?limit=&offset=`) |
| GET | `/runs/:id` | Run status and totals |
| POST | `/runs/:id/cancel`, `/runs/:id/resume` | Cancel; resume an interrupted or failed run |
| GET | `/runs/:id/logs` | Run log (`?after=<id>`) |
| GET | `/runs/:id/events` | Server-sent events: `status`, `progress` (≤ 1/s), `log` |
| GET, PATCH | `/runs/:id/candidates` | Dry run: list (`?sort=&minScore=&maxScore=&selected=`) / tick-untick |
| GET · POST | `/runs/:id/apply-preview` · `/runs/:id/apply` | Dry run: preview / add the selected candidates to the album |
| GET | `/assets/:id/thumbnail` | Thumbnail proxy (only assets seen in a run) |
| GET, PATCH | `/settings` | Runtime settings and app info |

---

## Development

| Path | What |
| --- | --- |
| `backend/` | NestJS 12 API, runner, scheduler (Node 22, ESM, SQLite via TypeORM) |
| `frontend/` | Angular 22 + Material SPA |
| `tools/immich-spike/` | API spike, fixtures and seeding for a throwaway Immich |
| `worker-py/` | Placeholder for the optional Python ML worker (phase 9) |

`backend` and `frontend` are independent npm packages (own lockfiles). Requires Node 22 (`nvm use`).

```bash
npm run install:all && npm run lint && npm test && npm run build
```

Backend against your Immich (with `backend/.env`: `IMMICH_URL`, `IMMICH_API_KEY`, `APP_PASSWORD`, `DATA_DIR=./data`):

```bash
cd backend && npm run start:dev        # http://localhost:3000
cd frontend && npm start               # http://localhost:4200 (proxies /api)
```

Tests: unit and e2e per package; contract tests against a real throwaway Immich and a 100k-asset scale test in `backend` (see [backend/README.md](backend/README.md)); Playwright UI tests in `frontend` (`npm run e2e:prepare && npm run e2e`).

Releases: push a tag `vX.Y.Z` → GitHub Actions builds and publishes `ghcr.io/gausim/immich-job-manager:X.Y.Z` (amd64 + arm64).
