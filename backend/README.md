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

Configuration: see the root README. `.env` in this directory is loaded automatically in development.

## Contract tests (real Immich)

Against a **throwaway** Immich v3 seeded with the spike fixtures (never your real library):

```bash
cd ../tools/immich-spike && npm run fixtures && IMMICH_URL=http://localhost:2283/api npm run seed
cd ../../backend
IMMICH_CONTRACT_URL=http://localhost:2283/api IMMICH_CONTRACT_KEY=$(cat ../tools/immich-spike/out/api-key) npm run test:contract
```

CI starts Immich from `.github/immich/docker-compose.yml` (job `immich-contract`).

## Scale test

`npm run test:scale` (also in CI): 100k fake assets with sample originals; prints runtime, files read, cache hits and heap per run, and asserts that the second run reads no files and that no memory is retained.

## Database migrations

SQLite via TypeORM; migrations run on boot, `synchronize` is off. After changing an entity:

```bash
DATA_DIR=/tmp/iaj-migrate npm run migration:generate -- src/persistence/migrations/<Name>
```

Then register the class in `src/persistence/migrations/index.ts`. The `migrations.spec.ts` test fails if entities and migrations drift apart.

Design: [SDD §8](../docs/design/immich-album-jobs-SDD.md#8-backend-nestjs).
