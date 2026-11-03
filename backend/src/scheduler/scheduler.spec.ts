import { ConflictException } from '@nestjs/common';
import {
  createRunnerHarness,
  type RunnerHarness,
} from '../../test/support/runner-harness.js';
import type { AppConfig } from '../config/config.schema.js';
import type { JobEntity } from '../persistence/entities/index.js';
import { RunLauncher } from '../runner/run-launcher.js';
import { RunQueue } from '../runner/run-queue.js';
import { SettingsService } from '../settings/settings.service.js';
import { SqliteService } from '../persistence/sqlite.service.js';
import { Housekeeping } from './housekeeping.service.js';
import { JobScheduler } from './job-scheduler.js';

const job = (over: Partial<JobEntity> = {}) =>
  ({
    id: 'j1',
    name: 'Job',
    enabled: true,
    schedule: '0 3 * * *',
    syncMode: 'additive',
    ...over,
  }) as JobEntity;

describe('JobScheduler', () => {
  const config = { tz: 'Europe/Berlin' } as AppConfig;
  let launched: unknown[];
  let busy: boolean;
  let scheduler: JobScheduler;
  let stored: JobEntity | null;

  beforeEach(() => {
    launched = [];
    busy = false;
    stored = job();
    const jobs = {
      findOneBy: async () => stored,
      find: async () => (stored ? [stored] : []),
    };
    const launcher = {
      launch: (j: JobEntity, o: unknown) => {
        if (busy)
          throw new ConflictException(
            'The job already has a queued or running run',
          );
        launched.push([j.id, o]);
        return {
          runId: 'r1',
          plan: {
            dryRun: false,
            full: false,
            since: null,
            reason: 'incremental',
          },
        };
      },
    };
    scheduler = new JobScheduler(
      config,
      jobs as never,
      launcher as unknown as RunLauncher,
    );
  });

  afterEach(() => scheduler.beforeApplicationShutdown());

  it('registers enabled jobs on boot and computes the next run in the configured time zone', async () => {
    await scheduler.onApplicationBootstrap();
    expect(scheduler.isScheduled('j1')).toBe(true);
    const next = scheduler.nextRun('j1')!;
    // 03:00 in Berlin is 01:00 or 02:00 UTC depending on DST.
    expect([1, 2]).toContain(next.getUTCHours());
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  it('re-registers on change and removes disabled or unscheduled jobs', () => {
    scheduler.sync(job({ schedule: '30 5 * * *' }));
    expect(scheduler.nextRun('j1')?.getUTCMinutes()).toBe(30);
    scheduler.sync(job({ enabled: false }));
    expect(scheduler.isScheduled('j1')).toBe(false);
    scheduler.sync(job({ schedule: null }));
    expect(scheduler.isScheduled('j1')).toBe(false);
    scheduler.sync(job());
    scheduler.remove('j1');
    expect(scheduler.nextRun('j1')).toBeNull();
  });

  it('starts a scheduled run, and skips it while the job is busy', async () => {
    expect(await scheduler.trigger('j1')).toBe('started');
    expect(launched).toEqual([['j1', { trigger: 'schedule' }]]);
    busy = true;
    expect(await scheduler.trigger('j1')).toBe('skipped');
    stored = job({ enabled: false });
    expect(await scheduler.trigger('j1')).toBe('not-scheduled');
  });
});

describe('RunLauncher.plan and housekeeping (real SQLite)', () => {
  let h: RunnerHarness;
  let launcher: RunLauncher;

  beforeEach(async () => {
    h = await createRunnerHarness({
      providers: [Housekeeping, SettingsService],
    });
    launcher = h.module.get(RunLauncher);
  });
  afterEach(() => h.close());

  const createJob = async (over: Partial<JobEntity> = {}) => {
    const { identifiers } = await h.jobs.insert({
      name: 'J',
      typeId: 'fake-source',
      typeVersion: 1,
      params: h.fake.defaultParams as never,
      targetAlbumName: 'A',
      syncMode: 'additive',
      ...over,
    });
    return h.jobs.findOneByOrFail({ id: identifiers[0].id as string });
  };

  it('plans full vs. incremental runs', async () => {
    const j = await createJob();
    expect(launcher.plan(j, {})).toMatchObject({
      dryRun: false,
      full: true,
      reason: 'first real run',
    });
    expect(launcher.plan(j, { dryRun: true })).toMatchObject({
      full: true,
      reason: 'dry runs always scan the whole library',
    });

    await h.runs.insert({
      jobId: j.id,
      dryRun: false,
      status: 'succeeded',
      startedAt: new Date('2026-11-01T10:00:00Z'),
    });
    await h.runs.insert({
      jobId: j.id,
      dryRun: false,
      status: 'failed',
      startedAt: new Date('2026-11-02T10:00:00Z'),
    });
    await h.runs.insert({
      jobId: j.id,
      dryRun: true,
      status: 'succeeded',
      startedAt: new Date('2026-11-03T10:00:00Z'),
    });
    expect(launcher.plan(j, {})).toEqual({
      dryRun: false,
      full: false,
      since: '2026-11-01 10:00:00.000', // last *successful real* run
      reason: 'incremental',
    });
    expect(launcher.plan(j, { fullRescan: true })).toMatchObject({
      full: true,
      reason: 'full rescan requested',
    });
    expect(
      launcher.plan(
        Object.assign(Object.create(null) as JobEntity, j, { typeVersion: 0 }),
        {},
      ),
    ).toMatchObject({
      full: true,
      reason: 'job type changed (v0 → v1)',
    });
  });

  it('launches with the plan stored on the run', async () => {
    const j = await createJob();
    await h.runs.insert({
      jobId: j.id,
      dryRun: false,
      status: 'succeeded',
      startedAt: new Date('2026-11-01T10:00:00Z'),
    });
    const { runId } = launcher.launch(j, { trigger: 'schedule' });
    await h.module.get(RunQueue).idle();
    const run = await h.runs.findOneByOrFail({ id: runId });
    expect(run).toMatchObject({
      trigger: 'schedule',
      fullRescan: false,
      since: new Date('2026-11-01T10:00:00Z'),
    });
  });

  it('records the job type version after a full real run, so the next run is incremental', async () => {
    const j = await createJob({ typeVersion: 0 });
    launcher.launch(j, { trigger: 'manual' });
    await h.module.get(RunQueue).idle();
    const updated = await h.jobs.findOneByOrFail({ id: j.id });
    expect(updated.typeVersion).toBe(1);
    expect(launcher.plan(updated, {})).toMatchObject({ full: false });
  });

  it('prunes candidates of old dry runs, old logs, and vacuums monthly', async () => {
    const j = await createJob();
    const db = h.module.get(SqliteService).db;
    const runIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      const { identifiers } = await h.runs.insert({
        jobId: j.id,
        dryRun: true,
        status: 'succeeded',
        createdAt: new Date(Date.UTC(2026, 10, 1 + i)),
      });
      const id = identifiers[0].id as string;
      runIds.push(id);
      db.prepare(
        `INSERT INTO run_candidate (run_id, asset_id, score, reasons) VALUES (?, 'a', 1, '[]'), (?, 'b', 1, '[]')`,
      ).run(id, id);
    }
    await h.logs.insert({
      runId: runIds[0],
      ts: new Date('2026-09-01T00:00:00Z'),
      level: 'info',
      message: 'old',
    });
    await h.logs.insert({
      runId: runIds[0],
      ts: new Date('2026-11-02T00:00:00Z'),
      level: 'info',
      message: 'new',
    });

    const housekeeping = h.module.get(Housekeeping);
    const now = new Date('2026-11-10T04:17:00Z');
    expect(housekeeping.run(now)).toEqual({
      prunedCandidates: 4,
      prunedLogLines: 1,
      vacuumed: true,
    });
    const kept = db
      .prepare('SELECT DISTINCT run_id FROM run_candidate')
      .all() as { run_id: string }[];
    expect(kept.map((r) => r.run_id).sort()).toEqual(runIds.slice(2).sort()); // newest 5
    expect(await h.runs.count()).toBe(7); // run history stays
    expect(housekeeping.run(new Date('2026-11-11T04:17:00Z')).vacuumed).toBe(
      false,
    ); // not due again yet
    expect(housekeeping.run(new Date('2026-12-11T04:17:00Z')).vacuumed).toBe(
      true,
    );
  });

  it('uses the retention settings', async () => {
    h.module.get(SettingsService).set('retention.dryRunCandidates', 1);
    const j = await createJob();
    const db = h.module.get(SqliteService).db;
    for (let i = 0; i < 3; i++) {
      const { identifiers } = await h.runs.insert({
        jobId: j.id,
        dryRun: true,
        status: 'succeeded',
        createdAt: new Date(Date.UTC(2026, 10, 1 + i)),
      });
      db.prepare(
        `INSERT INTO run_candidate (run_id, asset_id, score, reasons) VALUES (?, 'a', 1, '[]')`,
      ).run(identifiers[0].id);
    }
    expect(h.module.get(Housekeeping).run().prunedCandidates).toBe(2);
  });
});
