# Immich Album Jobs

Self-hosted companion app for [Immich](https://immich.app) v3: rerunnable, schedulable batch jobs that select assets (first job: screenshots) and keep them in an Immich album. Talks to Immich only through its REST API with a scoped API key.

> Status: **phase 3** – screenshot job with dry runs and a review API. No UI and no album writes yet.

## Docs

- [Software design document](docs/design/immich-album-jobs-SDD.md)
- [Implementation plan](docs/design/immich-album-jobs-implementation-plan.md) (progress is tracked there)
- [Immich API notes](docs/immich-api-notes.md) (phase 0 spike results, incl. required API key permissions)

## Layout

| Path | What |
| --- | --- |
| `backend/` | NestJS API, runner, scheduler (Node 22, ESM) |
| `frontend/` | Angular + Material SPA |
| `worker-py/` | Placeholder for the optional Python ML worker (phase 9) |
| `tools/immich-spike/` | Phase 0 API spike script |
| `docs/` | Design docs and notes |

`backend` and `frontend` are independent npm packages (own lockfiles), matching the Docker build. The root `package.json` only has convenience scripts.

## Development

Requires Node 22 (`nvm use`).

```bash
npm run install:all
npm run lint
npm test
npm run build
```

Run the backend against your Immich:

```bash
cd backend
cp ../.env.example .env      # then set IMMICH_URL, IMMICH_API_KEY, APP_PASSWORD, DATA_DIR=./data
npm run start:dev            # http://localhost:3000/api/health
```

`backend/.env` is loaded automatically when present (development only).

## Configuration

All settings are environment variables, validated at boot; an invalid value stops the app with a list of problems. See [`.env.example`](.env.example).

| Variable | Default | Meaning |
| --- | --- | --- |
| `IMMICH_URL` | – | Immich API base including `/api`, e.g. `http://immich_server:2283/api` |
| `IMMICH_API_KEY_FILE` | – | File with the Immich API key (Docker secret). `IMMICH_API_KEY` for development. |
| `APP_PASSWORD_FILE` | – | File with the app login password. `APP_PASSWORD` for development. Not needed with `AUTH_MODE=forward-auth`. |
| `AUTH_MODE` | `password` | `password` or `forward-auth` |
| `PY_WORKER_URL` | unset | Python ML worker (phase 9) |
| `DATA_DIR` | `/data` | SQLite location |
| `MAX_CONCURRENT_RUNS` | `2` | Global run limit |
| `MAX_FILE_READS` | `4` | Concurrent original-file reads from Immich |
| `PORT` | `3000` | HTTP port |
| `TZ` | `UTC` | Time zone for schedules |
| `LOG_LEVEL` | `info` | `fatal` … `trace` |

### Immich API key permissions

Create the key in Immich (Account settings → API keys) with exactly: `server.about`, `asset.read`, `asset.view`, `asset.download`, `album.read`, `album.create`, `albumAsset.create`, `albumAsset.delete`. Details in [the API notes](docs/immich-api-notes.md#2-api-key-permissions).

## API (so far)

All under `/api`. Validation errors: `400 { message: "Validation failed", errors: [{ path, message }] }`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/job-types` | Job types with params JSON Schema and defaults |
| GET, POST | `/jobs` | List / create jobs |
| GET, PATCH, DELETE | `/jobs/:id` | Read / update / delete (never touches Immich albums) |
| POST | `/jobs/:id/runs` | Start a run `{ dryRun?, fullRescan? }` (409 if one is already active) |
| GET | `/jobs/:id/runs` | Run history (`?limit=&offset=`) |
| GET | `/runs/:id` | Run status and totals |
| POST | `/runs/:id/cancel`, `/runs/:id/resume` | Cancel; resume an interrupted or failed run from its cursor |
| GET | `/runs/:id/logs` | Run log (`?after=<id>`) |
| GET | `/runs/:id/events` | Server-sent events: `status`, `progress` (≤ 1/s), `log` |
| GET | `/runs/:id/candidates` | Dry run: candidates (`?sort=-score\|score\|name&minScore=&maxScore=&selected=&limit=&offset=`) with summary counts |
| PATCH | `/runs/:id/candidates` | Dry run: tick/untick `{ selected, assetIds }` or `{ selected, filter }` |
| GET | `/assets/:id/thumbnail` | Thumbnail proxy (only assets seen in a run) |

```bash
curl -X POST localhost:3000/api/jobs -H 'content-type: application/json' \
  -d '{"name":"Screenshots","typeId":"screenshot-detector","targetAlbumName":"Screenshots"}'
curl -X POST localhost:3000/api/jobs/<id>/runs -H 'content-type: application/json' -d '{}'
curl -N localhost:3000/api/runs/<run-id>/events
curl 'localhost:3000/api/runs/<run-id>/candidates?limit=20'
```

## Health

`GET /api/health` returns `status: ok | degraded | error` with database and Immich state. It answers `200` while the database is up (Immich being down is `degraded`) and `503` otherwise.

## Docker

```bash
cp .env.example .env
mkdir -p secrets data && chmod 700 secrets
sudo chown 1000:1000 data   # the container runs as uid 1000 (node)
printf '%s' 'your-immich-api-key' > secrets/immich_api_key
printf '%s' 'your-app-password'   > secrets/app_password
touch secrets/immich_api_key_readonly
docker compose up -d --build
```

The container joins Immich's Docker network (`immich_default`; check with `docker network ls`).
