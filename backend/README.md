# Backend (NestJS)

NestJS 12 API, runner and scheduler for Immich Album Jobs. ESM, Vitest, oxlint, Prettier.

```bash
npm ci
npm run start:dev     # http://localhost:3000/api/health
npm run lint
npm test              # unit tests
npm run test:e2e      # e2e tests (supertest)
npm run build
```

Configuration: see the root README. For local development without logging in, set `AUTH_MODE=forward-auth` in `backend/.env`. `.env` in this directory is loaded automatically in development.

## Contract tests (real Immich)

Against a **throwaway** Immich v3 seeded with the spike fixtures (never your real library):

```bash
cd ../tools/immich-spike && npm run fixtures && IMMICH_URL=http://localhost:2283/api npm run seed
cd ../../backend
IMMICH_CONTRACT_URL=http://localhost:2283/api IMMICH_CONTRACT_KEY=$(cat ../tools/immich-spike/out/api-key) npm run test:contract
```

`IMMICH_CONTRACT_UPLOAD_KEY=$(cat ../tools/immich-spike/out/upload-key)` (an upload-only key created by the seed) enables the incremental upload test. Run against a *freshly* seeded instance: the tests assume the seeded library.

CI starts Immich from `.github/immich/docker-compose.yml` (job `immich-contract`).

## Scale test

`npm run test:scale` (also in CI): 100k fake assets with sample originals; prints runtime, files read, cache hits and heap per run, and asserts that the second run reads no files and that no memory is retained.

## Trip detection tuning

`npm run trips:detect` runs the trip detection of the trip albums job (`docs/design/trip-albums-SDD.md` §5) over a raw index export and prints the detected trips. It never talks to Immich.

1. Create the export with `tools/immich-spike` → `npm run trips`, which writes `out/trips-index.json`. Keep it private: it holds your GPS history.
2. Run it:

```bash
npm run trips:detect -- /path/to/trips-index.json
```

| Option | |
| --- | --- |
| `params.json` (second argument) | Job params to try, same shape as the job's, e.g. `{ "minTripDays": 1, "advanced": { "maxGapHours": 48 } }` |
| `--verbose` | Also list the stretches away that did not count as trips, and why (`too-short`, `too-few-assets`, `too-long`, `before-minimum-year`). |
| `--json out.json` | Write all trips with their asset ids and reasons. |
| `--now <ISO>` | Pretend "now" is this time (affects ongoing trips). |

Without Node on your machine, use Docker from the repository root:

```bash
docker run --rm -v "$PWD":/repo -v /path/to/trips-index.json:/trips-index.json:ro -w /repo/backend node:22 sh -c "npm ci && npm run trips:detect -- /trips-index.json"
```

## Database migrations

SQLite via TypeORM; migrations run on boot, `synchronize` is off. After changing an entity:

```bash
DATA_DIR=/tmp/iaj-migrate npm run migration:generate -- src/persistence/migrations/<Name>
```

Then register the class in `src/persistence/migrations/index.ts`. The `migrations.spec.ts` test fails if entities and migrations drift apart.

Design: [SDD §8](../docs/design/immich-album-jobs-SDD.md#8-backend-nestjs).
