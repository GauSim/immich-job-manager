import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Global, Injectable, Module, type Provider } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { z } from 'zod';
import { ConfigModule } from '../../src/config/config.module.js';
import { loadConfig } from '../../src/config/config.schema.js';
import { AlbumJobType } from '../../src/core/album-job-type.decorator.js';
import type {
  CandidateBatch,
  JobContext,
  JobType,
} from '../../src/core/job-type.js';
import { EventsModule } from '../../src/events/events.module.js';
import { ImmichClient } from '../../src/immich/immich.client.js';
import { JobTypesModule } from '../../src/jobs/job-types.module.js';
import {
  JobEntity,
  JobRunEntity,
  RunCandidateEntity,
  RunLogEntity,
} from '../../src/persistence/entities/index.js';
import { PersistenceModule } from '../../src/persistence/persistence.module.js';
import { SqliteService } from '../../src/persistence/sqlite.service.js';
import { RunnerModule } from '../../src/runner/runner.module.js';

/**
 * Fake source for runner tests: `total` assets in pages of `pageSize`; every
 * `matchEvery`-th asset is a candidate. Hooks let tests crash or block mid-run.
 */
export const FakeParams = z.object({
  total: z.number().int().min(0).default(10),
  pageSize: z.number().int().min(1).default(3),
  matchEvery: z.number().int().min(1).default(2),
  failAtPage: z.number().int().min(0).default(0),
});
export type FakeParams = z.infer<typeof FakeParams>;

@Injectable()
@AlbumJobType()
export class FakeSourceJob implements JobType<FakeParams> {
  readonly id = 'fake-source';
  readonly name = 'Fake source';
  readonly version = 1;
  readonly params = FakeParams;
  readonly defaultParams: FakeParams = {
    total: 10,
    pageSize: 3,
    matchEvery: 2,
    failAtPage: 0,
  };

  /** Called before page n (1-based) is produced; may throw or await. */
  beforePage?: (
    page: number,
    ctx: JobContext<FakeParams>,
  ) => void | Promise<void>;
  /** Pages produced, for assertions. */
  produced: number[] = [];

  async *select(ctx: JobContext<FakeParams>): AsyncIterable<CandidateBatch> {
    const { total, pageSize, matchEvery, failAtPage } = ctx.params;
    let page = ctx.resumeFrom ? Number(ctx.resumeFrom) : 0;
    while (page * pageSize < total) {
      page++;
      if (
        page === failAtPage &&
        this.produced.filter((p) => p === page).length === 0
      ) {
        this.produced.push(page);
        throw new Error(`Simulated crash at page ${page}`);
      }
      await this.beforePage?.(page, ctx);
      ctx.signal.throwIfAborted();
      this.produced.push(page);
      const start = (page - 1) * pageSize;
      const end = Math.min(start + pageSize, total);
      const candidates = [];
      for (let i = start; i < end; i++) {
        if (i % matchEvery === 0)
          candidates.push({
            assetId: `asset-${i}`,
            score: 0.9,
            reasons: ['fake'],
          });
      }
      yield {
        candidates,
        scanned: end - start,
        cursor: end < total ? String(page) : null,
      };
    }
  }
}

export const fakeImmich = {
  assertCompatible: async () => ({
    major: 3,
    minor: 3,
    patch: 5,
    version: 'v3.3.5',
  }),
} as unknown as ImmichClient;

@Global()
@Module({
  providers: [{ provide: ImmichClient, useValue: fakeImmich }, FakeSourceJob],
  exports: [ImmichClient],
})
class TestDoublesModule {}

export interface RunnerHarness {
  module: TestingModule;
  dataDir: string;
  jobs: Repository<JobEntity>;
  runs: Repository<JobRunEntity>;
  candidates: Repository<RunCandidateEntity>;
  logs: Repository<RunLogEntity>;
  sqlite: SqliteService;
  fake: FakeSourceJob;
  close(): Promise<void>;
}

/** Boots config + SQLite (temp dir) + runner with a fake Immich and fake job type. */
export async function createRunnerHarness(
  options: {
    dataDir?: string;
    maxConcurrentRuns?: number;
    providers?: Provider[];
  } = {},
): Promise<RunnerHarness> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'iaj-runner-'));
  const config = loadConfig({
    IMMICH_URL: 'http://immich.invalid/api',
    IMMICH_API_KEY: 'k',
    APP_PASSWORD: 'p',
    DATA_DIR: dataDir,
    MAX_CONCURRENT_RUNS: String(options.maxConcurrentRuns ?? 2),
  });
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot(config),
      PersistenceModule,
      EventsModule,
      JobTypesModule,
      TestDoublesModule,
      RunnerModule,
    ],
    providers: options.providers ?? [],
  }).compile();
  module.enableShutdownHooks();
  await module.init();
  return {
    module,
    dataDir,
    jobs: module.get(getRepositoryToken(JobEntity)),
    runs: module.get(getRepositoryToken(JobRunEntity)),
    candidates: module.get(getRepositoryToken(RunCandidateEntity)),
    logs: module.get(getRepositoryToken(RunLogEntity)),
    sqlite: module.get(SqliteService),
    fake: module.get(FakeSourceJob),
    close: async () => {
      await module.close();
      if (!options.dataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
