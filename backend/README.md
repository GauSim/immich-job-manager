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

## Database migrations

SQLite via TypeORM; migrations run on boot, `synchronize` is off. After changing an entity:

```bash
DATA_DIR=/tmp/iaj-migrate npm run migration:generate -- src/persistence/migrations/<Name>
```

Then register the class in `src/persistence/migrations/index.ts`. The `migrations.spec.ts` test fails if entities and migrations drift apart.

Design: [SDD §8](../docs/design/immich-album-jobs-SDD.md#8-backend-nestjs).
