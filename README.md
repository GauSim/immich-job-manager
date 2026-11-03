# Immich Album Jobs

Self-hosted companion app for [Immich](https://immich.app) v3: rerunnable, schedulable batch jobs that select assets (first job: screenshots) and keep them in an Immich album. Talks to Immich only through its REST API with a scoped API key.

> Status: **phase 0** – repository and tooling. Nothing usable yet.

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

## Docker

```bash
cp .env.example .env
mkdir -p secrets data && chmod 700 secrets
printf '%s' 'your-immich-api-key' > secrets/immich_api_key
printf '%s' 'your-app-password'   > secrets/app_password
touch secrets/immich_api_key_readonly
docker compose up -d --build
```

The container joins Immich's Docker network (`immich_default`; check with `docker network ls`).
