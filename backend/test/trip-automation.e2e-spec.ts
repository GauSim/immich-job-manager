import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.schema.js';
import { Clock } from '../src/core/clock.js';
import { RunQueue } from '../src/runner/run-queue.js';
import {
  FakeImmichLibrary,
  FakeImmichServer,
} from './support/fake-immich-server.js';
import { PLACES, Timeline } from './support/timeline.js';
import { toImmich } from './support/trip-library.js';

const THAI = 'Thailand – Mar 2026';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Trip albums phase T6: configure once, runs by itself. */
describe('Trip albums: automation (e2e)', () => {
  let immich: FakeImmichServer;
  let lib: FakeImmichLibrary;
  let t: Timeline;
  let dataDir: string;
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    t = new Timeline('me');
    t.days('2026-01-01', '2026-03-03', PLACES.berlinHome);
    t.days('2026-03-04', '2026-03-10', PLACES.bangkok);
    immich = await new FakeImmichServer().start();
    lib = new FakeImmichLibrary(immich, t.assets.map(toImmich));
    immich.on('GET /users/me', () => ({ json: { id: 'me' } }));
    dataDir = mkdtempSync(join(tmpdir(), 'iaj-trip-auto-e2e-'));
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

  /** Moves the app's clock (trips are "ongoing" relative to now). */
  const at = (iso: string) => {
    app.get(Clock).now = () => new Date(iso);
  };
  /** Publishes the timeline to the fake Immich (new uploads). */
  const sync = () => {
    lib.assets = t.assets.map(toImmich);
  };

  const createJob = async (extra: Record<string, unknown> = {}) =>
    (
      await http
        .post('/api/jobs')
        .send({
          name: 'Trips',
          typeId: 'trip-albums',
          syncMode: 'additive',
          ...extra,
        })
        .expect(201)
    ).body as { id: string };

  const realRun = async (jobId: string) => {
    const r = (
      await http
        .post(`/api/jobs/${jobId}/runs`)
        .send({ dryRun: false })
        .expect(202)
    ).body as { id: string };
    await app.get(RunQueue).idle();
    const run = (await http.get(`/api/runs/${r.id}`).expect(200)).body as {
      status: string;
      error: string | null;
      added: number;
    };
    expect(run).toMatchObject({ status: 'succeeded', error: null });
    return run;
  };

  const groups = async (jobId: string) =>
    (await http.get(`/api/jobs/${jobId}/groups`).expect(200)).body as {
      name: string;
      status: string;
      summary: { localEnd: string };
    }[];

  it('follows an ongoing trip until home, then picks up late imports and keeps edits', async () => {
    const job = await createJob();

    // Day 8 of the trip: the album exists and the trip is ongoing.
    at('2026-03-11T05:00:00Z');
    const first = await realRun(job.id);
    expect(first.added).toBe(14);
    expect(lib.members(THAI)).toHaveLength(14);
    expect((await groups(job.id))[0].status).toBe('ongoing');

    // Three more days abroad: the album grows.
    t.days('2026-03-11', '2026-03-13', PLACES.bangkok);
    sync();
    at('2026-03-14T00:00:00Z');
    expect((await realRun(job.id)).added).toBe(6);
    expect(lib.members(THAI)).toHaveLength(20);
    expect((await groups(job.id))[0].status).toBe('ongoing');

    // Flew home: the arrival photo at BER joins, the trip is closed.
    const arrival = t.shot('2026-03-14T06:45', PLACES.ber);
    t.days('2026-03-14', '2026-03-20', PLACES.berlinHome);
    sync();
    at('2026-03-21T10:00:00Z');
    await realRun(job.id);
    const [closed] = await groups(job.id);
    expect(closed.status).toBe('active');
    expect(closed.summary.localEnd).toBe('2026-03-14T08:59:59.999');
    expect(lib.members(THAI)).toContain(arrival.id);
    expect(lib.members(THAI)).toHaveLength(21);

    // Later: the user removes a photo, and the camera's SD card is imported.
    const removed = lib.members(THAI)[0];
    lib.album(THAI)!.members.delete(removed);
    const camera = t.shot('2026-03-08T12:00', null, { noTimeZone: true });
    sync();
    at('2026-03-25T10:00:00Z');
    expect((await realRun(job.id)).added).toBe(1);
    expect(lib.members(THAI)).toContain(camera.id);
    expect(lib.members(THAI)).not.toContain(removed);
  });

  it('runs on a schedule and creates the trip album by itself', async () => {
    at('2026-03-25T10:00:00Z');
    t.days('2026-03-11', '2026-03-20', PLACES.berlinHome);
    sync();
    const job = await createJob({ schedule: '* * * * * *', enabled: true });
    await expect
      .poll(() => lib.members(THAI).length, { timeout: 15_000, interval: 200 })
      .toBe(14);
    await http
      .patch(`/api/jobs/${job.id}`)
      .send({ enabled: false })
      .expect(200);
    await app.get(RunQueue).idle();
    await sleep(1100);
    const runs = (
      await http.get(`/api/jobs/${job.id}/runs?limit=100`).expect(200)
    ).body.items as { trigger: string; dryRun: boolean; status: string }[];
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.trigger === 'schedule' && !r.dryRun)).toBe(true);
    expect(runs.every((r) => r.status === 'succeeded')).toBe(true);
    expect(lib.albums.size).toBe(2); // the trip album and the exclusion album
  }, 40_000);

  describe('partner assets', () => {
    beforeEach(() => {
      t.days('2026-03-11', '2026-03-20', PLACES.berlinHome);
      at('2026-03-25T10:00:00Z');
    });

    it('fill: timeline photos of the partner join the trip, archived ones never', async () => {
      const shared = t.shot('2026-03-06T15:00', PLACES.bangkok, {
        ownerId: 'partner',
      });
      const archived = t.shot('2026-03-07T15:00', PLACES.bangkok, {
        ownerId: 'partner',
        visibility: 'archive',
      });
      // A trip only the partner took: no album.
      t.days('2026-04-01', '2026-04-05', PLACES.prague, { ownerId: 'partner' });
      sync();
      const job = await createJob();
      await realRun(job.id);
      expect(lib.members(THAI)).toContain(shared.id);
      expect(lib.members(THAI)).not.toContain(archived.id);
      expect([...lib.albums.values()].map((a) => a.albumName).sort()).toEqual([
        THAI,
        'Trips – excluded',
      ]);
    });

    it('off: partner photos are ignored', async () => {
      const shared = t.shot('2026-03-06T15:00', PLACES.bangkok, {
        ownerId: 'partner',
      });
      sync();
      const job = await createJob({ params: { partnerAssets: 'off' } });
      await realRun(job.id);
      expect(lib.members(THAI)).not.toContain(shared.id);
    });
  });
});
