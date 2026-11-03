import { rmSync } from 'node:fs';
import {
  createRunnerHarness,
  fakeImmich,
  type RunnerHarness,
} from '../../test/support/runner-harness.js';
import {
  RunEventsService,
  type RunEvent,
} from '../events/run-events.service.js';
import { RunCancelledError } from './run-errors.js';
import { RunQueue } from './run-queue.js';

describe('RunExecutor (with RunQueue, real SQLite)', () => {
  let h: RunnerHarness;
  let queue: RunQueue;

  beforeEach(async () => {
    fakeImmich.albums.clear();
    fakeImmich.calls = { create: 0, add: 0, remove: 0 };
    h = await createRunnerHarness();
    queue = h.module.get(RunQueue);
  });

  afterEach(() => h.close());

  async function createJob(params: Record<string, unknown> = {}) {
    const { identifiers } = await h.jobs.insert({
      name: 'Test job',
      typeId: 'fake-source',
      params: { ...h.fake.defaultParams, ...params } as never,
      targetAlbumName: 'Test',
    });
    return identifiers[0].id as string;
  }

  async function startRun(jobId: string, dryRun = true) {
    const { identifiers } = await h.runs.insert({ jobId, dryRun });
    const runId = identifiers[0].id as string;
    queue.enqueue(runId, jobId);
    return runId;
  }

  const run = (id: string) => h.runs.findOneByOrFail({ id });

  it('persists every page: totals, candidates (dry run) and cursor', async () => {
    const jobId = await createJob({ total: 10, pageSize: 3, matchEvery: 2 });
    const runId = await startRun(jobId);
    await queue.idle();

    expect(await run(runId)).toMatchObject({
      status: 'succeeded',
      scanned: 10,
      matched: 5,
      cursor: null,
      error: null,
    });
    const ids = (
      await h.candidates.find({ where: { runId }, order: { assetId: 'ASC' } })
    ).map((c) => c.assetId);
    expect(ids).toEqual([
      'asset-0',
      'asset-2',
      'asset-4',
      'asset-6',
      'asset-8',
    ]);
    expect(
      (await h.candidates.findOneByOrFail({ runId, assetId: 'asset-0' }))
        .selected,
    ).toBe(true);

    const messages = (
      await h.logs.find({ where: { runId }, order: { id: 'ASC' } })
    ).map((l) => l.message);
    expect(messages[0]).toMatch(/^Starting dry run of "Test job"/);
    expect(messages.at(-1)).toMatch(/^Finished: 10 scanned, 5 matched/);
  });

  describe('album sync (real runs)', () => {
    const owned = async (jobId: string) =>
      h.sqlite.db
        .prepare(
          'SELECT asset_id FROM job_asset WHERE job_id = ? ORDER BY asset_id',
        )
        .all(jobId)
        .map((r) => (r as { asset_id: string }).asset_id);
    const members = (name: string) =>
      [...(fakeImmich.album(name)?.members ?? [])].sort();

    it('adds matches to the album (creating both albums) and records ownership', async () => {
      const jobId = await createJob();
      const runId = await startRun(jobId, false);
      await queue.idle();
      expect(await run(runId)).toMatchObject({
        status: 'succeeded',
        matched: 5,
        added: 5,
        removed: 0,
      });
      expect(members('Test')).toEqual([
        'asset-0',
        'asset-2',
        'asset-4',
        'asset-6',
        'asset-8',
      ]);
      expect(fakeImmich.album('Test – excluded')).toBeDefined();
      expect(await owned(jobId)).toEqual(members('Test'));
      expect(await h.candidates.countBy({ runId })).toBe(0); // real runs store totals only
      expect(
        (await h.jobs.findOneByOrFail({ id: jobId })).targetAlbumId,
      ).toBeTruthy();
      const last = (
        await h.logs.find({ where: { runId }, order: { id: 'DESC' } })
      )[0].message;
      expect(last).toMatch(
        /^Finished: 10 scanned, 5 matched, 5 added, 0 removed, 0 already in album/,
      );
    });

    it('makes zero album writes on a rerun without changes', async () => {
      const jobId = await createJob();
      await startRun(jobId, false);
      await queue.idle();
      fakeImmich.calls = { create: 0, add: 0, remove: 0 };
      const second = await startRun(jobId, false);
      await queue.idle();
      expect(fakeImmich.calls).toEqual({ create: 0, add: 0, remove: 0 });
      expect(await run(second)).toMatchObject({
        status: 'succeeded',
        matched: 5,
        added: 0,
      });
    });

    it('keeps assets of the exclusion album out (real and dry runs)', async () => {
      fakeImmich.createAlbum('Test – excluded', ['asset-2']);
      const jobId = await createJob();
      const real = await startRun(jobId, false);
      await queue.idle();
      expect(members('Test')).not.toContain('asset-2');
      expect(await run(real)).toMatchObject({ matched: 4, added: 4 });
      const dry = await startRun(jobId, true);
      await queue.idle();
      expect(
        (await h.candidates.findBy({ runId: dry })).map((c) => c.assetId),
      ).not.toContain('asset-2');
    });

    it('mirror mode removes owned non-matches but never assets added by hand', async () => {
      const jobId = await createJob({ total: 10, matchEvery: 2 });
      await h.jobs.update(jobId, { syncMode: 'mirror' });
      await startRun(jobId, false);
      await queue.idle();
      fakeImmich.album('Test')!.members.add('manual-1'); // added by the user in Immich

      await h.jobs.update(jobId, {
        params: { ...h.fake.defaultParams, matchEvery: 4 } as never,
      }); // fewer matches
      const second = await startRun(jobId, false);
      await queue.idle();
      expect(await run(second)).toMatchObject({
        status: 'succeeded',
        matched: 3,
        added: 0,
        removed: 2,
      });
      expect(members('Test')).toEqual([
        'asset-0',
        'asset-4',
        'asset-8',
        'manual-1',
      ]);
      expect(await owned(jobId)).toEqual(['asset-0', 'asset-4', 'asset-8']);
    });

    it('additive mode never removes', async () => {
      const jobId = await createJob();
      await startRun(jobId, false);
      await queue.idle();
      await h.jobs.update(jobId, {
        params: { ...h.fake.defaultParams, matchEvery: 4 } as never,
      });
      const second = await startRun(jobId, false);
      await queue.idle();
      expect(await run(second)).toMatchObject({ removed: 0 });
      expect(members('Test')).toHaveLength(5);
      expect(fakeImmich.calls.remove).toBe(0);
    });

    it('mirror mode skips removals when a run was resumed', async () => {
      const jobId = await createJob({ total: 10, pageSize: 3, failAtPage: 3 });
      await h.jobs.update(jobId, { syncMode: 'mirror' });
      const runId = await startRun(jobId, false);
      await queue.idle();
      expect(await run(runId)).toMatchObject({ status: 'failed', added: 3 }); // pages 1–2 written
      await h.runs.update(runId, { status: 'queued' });
      queue.enqueue(runId, jobId);
      await queue.idle();
      expect(await run(runId)).toMatchObject({
        status: 'succeeded',
        added: 5,
        removed: 0,
      });
      expect(fakeImmich.calls.remove).toBe(0);
      const messages = (await h.logs.findBy({ runId, level: 'warn' })).map(
        (l) => l.message,
      );
      expect(messages).toContainEqual(
        expect.stringMatching(/removals skipped because this run was resumed/),
      );
    });

    it('dry runs never create albums', async () => {
      const jobId = await createJob();
      await startRun(jobId, true);
      await queue.idle();
      expect(fakeImmich.albums.size).toBe(0);
      expect(fakeImmich.calls).toEqual({ create: 0, add: 0, remove: 0 });
    });
  });

  it('persists a page before the next one is produced', async () => {
    const jobId = await createJob({ total: 9, pageSize: 3 });
    const seen: number[] = [];
    h.fake.beforePage = (page, ctx) => {
      const row = h.sqlite.db
        .prepare('SELECT scanned FROM job_run WHERE id = ?')
        .get(ctx.runId) as { scanned: number };
      seen.push(row.scanned);
      expect(row.scanned).toBe((page - 1) * 3);
    };
    await startRun(jobId);
    await queue.idle();
    expect(seen).toEqual([0, 3, 6]);
  });

  it('fails with a saved cursor and resumes from it after a crash', async () => {
    const jobId = await createJob({ total: 10, pageSize: 3, failAtPage: 3 });
    const runId = await startRun(jobId);
    await queue.idle();

    const failed = await run(runId);
    expect(failed).toMatchObject({
      status: 'failed',
      scanned: 6,
      matched: 3,
      cursor: '2',
    });
    expect(failed.error).toMatch(/Simulated crash at page 3/);

    // Resume: same run, continues after page 2.
    await h.runs.update(runId, { status: 'queued' });
    queue.enqueue(runId, jobId);
    await queue.idle();

    expect(await run(runId)).toMatchObject({
      status: 'succeeded',
      scanned: 10,
      matched: 5,
      cursor: null,
      error: null,
    });
    expect(h.fake.produced).toEqual([1, 2, 3, 3, 4]); // pages 1–2 not produced again
    expect(await h.candidates.countBy({ runId })).toBe(5);
    const messages = (
      await h.logs.find({ where: { runId }, order: { id: 'ASC' } })
    ).map((l) => l.message);
    expect(messages).toContainEqual(expect.stringMatching(/^Resuming dry run/));
  });

  it('cancels a running run and keeps progress', async () => {
    const jobId = await createJob({ total: 30, pageSize: 3 });
    h.fake.beforePage = async (page, ctx) => {
      if (page === 3) {
        queue.abort(ctx.runId, new RunCancelledError());
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const runId = await startRun(jobId);
    await queue.idle();
    expect(await run(runId)).toMatchObject({
      status: 'cancelled',
      scanned: 6,
      cursor: '2',
      error: null,
    });
    expect((await run(runId)).finishedAt).toBeInstanceOf(Date);
  });

  it('marks a run interrupted on shutdown; on the next boot it can resume', async () => {
    const jobId = await createJob({ total: 30, pageSize: 3 });
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    h.fake.beforePage = async (page, ctx) => {
      if (page === 4) {
        ctx.signal.addEventListener('abort', () => release());
        await blocked;
      }
    };
    const runId = await startRun(jobId);
    await vi.waitFor(async () => expect((await run(runId)).scanned).toBe(9));

    const dataDir = h.dataDir;
    await h.module.close(); // shutdown hooks interrupt the run
    h = await createRunnerHarness({ dataDir });
    queue = h.module.get(RunQueue);
    expect(await run(runId)).toMatchObject({
      status: 'interrupted',
      scanned: 9,
      cursor: '3',
    });

    await h.runs.update(runId, { status: 'queued' });
    queue.enqueue(runId, jobId);
    await queue.idle();
    expect(await run(runId)).toMatchObject({
      status: 'succeeded',
      scanned: 30,
    });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('on boot turns leftover running runs into interrupted and re-queues queued runs', async () => {
    const jobA = await createJob();
    const jobB = await createJob();
    const { identifiers: crashed } = await h.runs.insert({
      jobId: jobA,
      status: 'running',
      scanned: 3,
      cursor: '1',
    });
    const { identifiers: waiting } = await h.runs.insert({
      jobId: jobB,
      status: 'queued',
    });

    const dataDir = h.dataDir;
    await h.module.close();
    h = await createRunnerHarness({ dataDir });
    queue = h.module.get(RunQueue);
    await queue.idle();

    expect(await run(crashed[0].id as string)).toMatchObject({
      status: 'interrupted',
      error: 'Interrupted by a restart',
      cursor: '1',
    });
    expect(await run(waiting[0].id as string)).toMatchObject({
      status: 'succeeded',
      scanned: 10,
    });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('fails cleanly on invalid params or unknown job types', async () => {
    const badParams = await createJob({ pageSize: 0 });
    const r1 = await startRun(badParams);
    const { identifiers } = await h.jobs.insert({
      name: 'x',
      typeId: 'gone',
      params: {},
      targetAlbumName: 'x',
    });
    const r2 = await startRun(identifiers[0].id as string);
    await queue.idle();
    expect((await run(r1)).error).toMatch(/Invalid job params: pageSize/);
    expect((await run(r2)).error).toMatch(/Unknown job type "gone"/);
  });

  it('emits throttled progress and a final status', async () => {
    const events: RunEvent[] = [];
    const jobId = await createJob({ total: 300, pageSize: 3 });
    const { identifiers } = await h.runs.insert({ jobId, dryRun: true });
    const runId = identifiers[0].id as string;
    h.module
      .get(RunEventsService)
      .stream(runId)
      .subscribe((e) => events.push(e));
    queue.enqueue(runId, jobId);
    await queue.idle();
    const progress = events.filter((e) => e.type === 'progress');
    expect(progress.length).toBeLessThanOrEqual(3); // 100 pages in well under 2 s
    expect(events.at(-1)).toMatchObject({
      type: 'status',
      data: { status: 'succeeded', scanned: 300 },
    });
  });

  it('keeps memory flat over 100k assets', async () => {
    const jobId = await createJob({
      total: 100_000,
      pageSize: 1000,
      matchEvery: 10,
    });
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    h.fake.beforePage = () => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    };
    const runId = await startRun(jobId);
    await queue.idle();
    expect(await run(runId)).toMatchObject({
      status: 'succeeded',
      scanned: 100_000,
      matched: 10_000,
    });
    // Generous bound: the runner holds one page at a time, not 100k assets.
    expect((peak - before) / 1024 / 1024).toBeLessThan(64);
  }, 30_000);
});
