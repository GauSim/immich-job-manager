import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.schema.js';
import { SqliteService, sqliteNow } from '../src/persistence/sqlite.service.js';
import { RunQueue } from '../src/runner/run-queue.js';
import {
  FakeImmichLibrary,
  FakeImmichServer,
} from './support/fake-immich-server.js';
import { PLACES, Timeline } from './support/timeline.js';
import { toImmich } from './support/trip-library.js';

/** Home in Berlin with one trip to Bangkok (2026-03-04 … 03-18) and a camera photo without GPS. */
function library() {
  const t = new Timeline('me');
  t.days('2026-01-01', '2026-03-03', PLACES.berlinHome);
  t.days('2026-03-04', '2026-03-18', PLACES.bangkok);
  const camera = t.shot('2026-03-10T12:00', null, {
    noTimeZone: true,
    id: 'camera-no-gps',
  });
  const unwanted = t.shot('2026-03-11T12:00', PLACES.bangkok, {
    id: 'unwanted',
  });
  t.days('2026-03-19', '2026-05-31', PLACES.berlinHome);
  return { assets: t.assets, camera, unwanted };
}

describe('Trip albums dry run & review (e2e)', () => {
  let immich: FakeImmichServer;
  let lib: FakeImmichLibrary;
  let dataDir: string;
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  const { assets, camera, unwanted } = library();

  beforeEach(async () => {
    immich = await new FakeImmichServer().start();
    lib = new FakeImmichLibrary(immich, assets.map(toImmich));
    immich.on('GET /users/me', () => ({
      json: { id: 'me', email: 'me@example.com', name: 'Me' },
    }));
    dataDir = mkdtempSync(join(tmpdir(), 'iaj-trips-e2e-'));
    const config = loadConfig({
      IMMICH_URL: immich.url,
      IMMICH_API_KEY: 'k',
      APP_PASSWORD: 'p',
      AUTH_MODE: 'forward-auth',
      DATA_DIR: dataDir,
      NODE_ENV: 'production',
      LOG_LEVEL: 'fatal',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(config)],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.init();
    http = request(app.getHttpServer());
  });

  afterEach(async () => {
    await app.close();
    await immich.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const idle = () => app.get(RunQueue).idle();

  const createJob = async () =>
    (
      await http
        .post('/api/jobs')
        .send({ name: 'Trips', typeId: 'trip-albums' })
        .expect(201)
    ).body as {
      id: string;
      typeKind: string;
      targetAlbumName: string;
      effectiveExclusionAlbumName: string;
    };

  const dryRun = async (jobId: string) => {
    const run = (
      await http
        .post(`/api/jobs/${jobId}/runs`)
        .send({ dryRun: true })
        .expect(202)
    ).body as { id: string };
    await idle();
    return (await http.get(`/api/runs/${run.id}`).expect(200)).body as {
      id: string;
      status: string;
      error: string | null;
      scanned: number;
      matched: number;
    };
  };

  const albumWrites = () => lib.allAlbumWrites();

  it('lists the trip job type as a group job with its params schema', async () => {
    const res = await http.get('/api/job-types').expect(200);
    const type = (
      res.body as {
        id: string;
        kind: string;
        paramsSchema: { properties: Record<string, unknown> };
      }[]
    ).find((t) => t.id === 'trip-albums');
    expect(type?.kind).toBe('groups');
    expect(Object.keys(type!.paramsSchema.properties)).toEqual(
      expect.arrayContaining(['awayRule', 'nameTemplate', 'advanced']),
    );
    const screenshot = (res.body as { id: string; kind: string }[]).find(
      (t) => t.id === 'screenshot-detector',
    );
    expect(screenshot?.kind).toBe('assets');
  });

  it('creates group jobs without a target album (asset jobs still need one)', async () => {
    const job = await createJob();
    expect(job.targetAlbumName).toBe('');
    expect(job.typeKind).toBe('groups');
    expect(job.effectiveExclusionAlbumName).toBe('Trips – excluded');
    await http
      .post('/api/jobs')
      .send({ name: 'Shots', typeId: 'screenshot-detector' })
      .expect(400);
    await http
      .patch(`/api/jobs/${job.id}`)
      .send({ targetAlbumName: 'X' })
      .expect(400);
  });

  it('dry-runs: indexes the library, proposes trips, changes nothing in Immich', async () => {
    const job = await createJob();
    const run = await dryRun(job.id);
    expect(run).toMatchObject({ status: 'succeeded', error: null });
    expect(run.scanned).toBe(assets.length);

    const groups = (await http.get(`/api/runs/${run.id}/groups`).expect(200))
      .body as {
      items: {
        key: string;
        action: string;
        name: string;
        assetCount: number;
        selected: boolean;
        summary: { countries: string[]; days: number };
      }[];
      summary: Record<string, number>;
    };
    expect(groups.items).toHaveLength(1);
    const [trip] = groups.items;
    expect(trip).toMatchObject({
      key: 'trip:2026-03-04',
      action: 'create',
      name: 'Thailand – Mar 2026',
      selected: true,
      summary: expect.objectContaining({ countries: ['Thailand'] }),
    });
    expect(groups.summary).toMatchObject({ create: 1, selected: 1 });
    expect(run.matched).toBe(trip.assetCount);

    const members = (
      await http
        .get(`/api/runs/${run.id}/candidates`)
        .query({ group: trip.key, limit: 1000 })
        .expect(200)
    ).body as {
      items: { assetId: string; reasons: string[] }[];
      total: number;
    };
    expect(members.total).toBe(trip.assetCount);
    expect(members.items.find((c) => c.assetId === camera.id)?.reasons).toEqual(
      ['no-gps-camera'],
    );

    expect(albumWrites()).toBe(0);
    await http
      .get(`/api/runs/${run.id}/candidates`)
      .query({ group: 'nope' })
      .expect(200)
      .expect((res) => expect((res.body as { total: number }).total).toBe(0));
  });

  it('keeps assets of the exclusion album out of the trips', async () => {
    lib.addAlbum('Trips – excluded', [unwanted.id]);
    const job = await createJob();
    const run = await dryRun(job.id);
    const members = (
      await http
        .get(`/api/runs/${run.id}/candidates`)
        .query({ limit: 1000 })
        .expect(200)
    ).body as { items: { assetId: string }[] };
    expect(members.items.map((c) => c.assetId)).not.toContain(unwanted.id);
    expect(members.items.map((c) => c.assetId)).toContain(camera.id);
  });

  it('ticks and unticks proposed trips', async () => {
    const job = await createJob();
    const run = await dryRun(job.id);
    const res = await http
      .patch(`/api/runs/${run.id}/groups`)
      .send({ selected: false })
      .expect(200);
    expect(res.body).toMatchObject({ updated: 1, summary: { selected: 0 } });
    await http
      .patch(`/api/runs/${run.id}/groups`)
      .send({ selected: true, keys: ['trip:2026-03-04'] })
      .expect(200)
      .expect((r) =>
        expect(
          (r.body as { summary: { selected: number } }).summary.selected,
        ).toBe(1),
      );
  });

  it('matches a stored trip (update) and respects ignored trips', async () => {
    const job = await createJob();
    const groupId = randomUUID();
    const sqlite = app.get(SqliteService);
    sqlite.db
      .prepare(
        `INSERT INTO job_group (id, job_id, key, status, start_at, end_at, core_start_at, core_end_at, summary,
           album_id, generated_name, created_at, updated_at)
         VALUES (?, ?, 'trip:2026-03-05', 'active', ?, ?, ?, ?, '{}', 'album-1', 'Thailand – Mar 2026', ?, ?)`,
      )
      .run(
        groupId,
        job.id,
        sqliteNow(new Date('2026-03-04T00:00:00Z')),
        sqliteNow(new Date('2026-03-18T00:00:00Z')),
        sqliteNow(new Date('2026-03-05T00:00:00Z')),
        sqliteNow(new Date('2026-03-17T00:00:00Z')),
        sqliteNow(),
        sqliteNow(),
      );

    let run = await dryRun(job.id);
    let groups = (await http.get(`/api/runs/${run.id}/groups`).expect(200))
      .body as {
      items: { action: string; jobGroupId: string; albumId: string }[];
    };
    expect(groups.items).toEqual([
      expect.objectContaining({
        action: 'update',
        jobGroupId: groupId,
        albumId: 'album-1',
      }),
    ]);

    const stored = (await http.get(`/api/jobs/${job.id}/groups`).expect(200))
      .body as { id: string; status: string }[];
    expect(stored).toEqual([
      expect.objectContaining({ id: groupId, status: 'active' }),
    ]);
    await http
      .patch(`/api/jobs/${job.id}/groups/${groupId}`)
      .send({ status: 'ignored' })
      .expect(200)
      .expect((r) =>
        expect((r.body as { status: string }).status).toBe('ignored'),
      );
    await http
      .patch(`/api/jobs/${job.id}/groups/${randomUUID()}`)
      .send({ status: 'ignored' })
      .expect(404);

    run = await dryRun(job.id);
    groups = (await http.get(`/api/runs/${run.id}/groups`).expect(200))
      .body as typeof groups;
    expect(groups.items).toEqual([
      expect.objectContaining({ action: 'ignored', jobGroupId: groupId }),
    ]);
    expect(run.matched).toBe(0);
  });

  it('resumes a run that failed during the index refresh', async () => {
    // A larger library: more than one index page (1,000 assets per page).
    const t = new Timeline('me');
    t.days('2023-01-01', '2026-03-03', PLACES.berlinHome);
    t.days('2026-03-04', '2026-03-18', PLACES.bangkok);
    t.days('2026-03-19', '2026-05-31', PLACES.berlinHome);
    lib.assets = t.assets.map(toImmich);
    let failNext = true;
    immich.on('POST /search/metadata', (req) => {
      const body = req.body as {
        cursor?: string;
        filter?: { albumIds?: unknown };
      };
      if (body.cursor && !body.filter?.albumIds && failNext) {
        failNext = false;
        return { status: 400, json: { message: 'Simulated failure' } };
      }
      return lib['search'](req);
    });

    const job = await createJob();
    const failed = await dryRun(job.id);
    expect(failed.status).toBe('failed');
    expect(failed.scanned).toBe(1000);

    await http.post(`/api/runs/${failed.id}/resume`).expect(202);
    await idle();
    const resumed = (await http.get(`/api/runs/${failed.id}`).expect(200))
      .body as { status: string; scanned: number };
    expect(resumed.status).toBe('succeeded');
    expect(resumed.scanned).toBe(t.assets.length);
    const groups = (await http.get(`/api/runs/${failed.id}/groups`).expect(200))
      .body as { items: { key: string }[] };
    expect(groups.items.map((g) => g.key)).toEqual(['trip:2026-03-04']);
  });

  it('reports the inferred home per month', async () => {
    const job = await createJob();
    await dryRun(job.id); // fills the index
    const res = await http.get(`/api/jobs/${job.id}/insights`).expect(200);
    expect((res.body as { home: { country: string }[] }).home).toEqual([
      expect.objectContaining({
        from: '2026-01',
        to: '2026-05',
        country: 'Germany',
      }),
    ]);
  });
});
