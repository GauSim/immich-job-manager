import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.schema.js';
import { RunQueue } from '../src/runner/run-queue.js';
import {
  FakeImmichLibrary,
  FakeImmichServer,
} from './support/fake-immich-server.js';

const uuid = (s: string) => {
  const h = createHash('sha1').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A screenshot uploaded "now" (updated after any earlier run). */
const newScreenshot = (name: string) => ({
  id: uuid(name),
  type: 'IMAGE',
  originalFileName: name,
  originalMimeType: 'image/png',
  checksum: `sum-${name}`,
  width: 1320,
  height: 2868,
  updatedAt: new Date(Date.now() + 1000).toISOString(),
  exifInfo: { make: null, model: null, description: 'Screenshot' },
});

describe('Scheduler & incremental runs (e2e)', () => {
  let immich: FakeImmichServer;
  let lib: FakeImmichLibrary;
  let dataDir: string;
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    immich = await new FakeImmichServer().start();
    const sample = (
      JSON.parse(
        readFileSync(
          join(import.meta.dirname, 'fixtures/real-library-sample.json'),
          'utf8',
        ),
      ) as { id: string }[]
    ).map((a) => ({ ...a, id: uuid(a.id), checksum: `sum-${a.id}` }));
    lib = new FakeImmichLibrary(immich, sample);
    lib.defaultOriginal = readFileSync(
      join(import.meta.dirname, 'fixtures/files/png-without-tag.png'),
    );
    dataDir = mkdtempSync(join(tmpdir(), 'iaj-schedule-e2e-'));
    const config = loadConfig({
      IMMICH_URL: immich.url,
      IMMICH_API_KEY: 'k',
      APP_PASSWORD: 'p',
      DATA_DIR: dataDir,
      TZ: 'Europe/Berlin',
      NODE_ENV: 'production',
      LOG_LEVEL: 'fatal',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(config)],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.enableShutdownHooks();
    await app.init();
    http = request(app.getHttpServer());
  });

  afterEach(async () => {
    await app.close();
    await immich.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const createJob = async (body: Record<string, unknown> = {}) =>
    (
      await http
        .post('/api/jobs')
        .send({
          name: 'Screenshots',
          typeId: 'screenshot-detector',
          targetAlbumName: 'Screenshots',
          syncMode: 'additive',
          ...body,
        })
        .expect(201)
    ).body as { id: string; nextRunAt: string | null };
  const run = async (jobId: string, body: Record<string, unknown> = {}) => {
    const { body: started } = await http
      .post(`/api/jobs/${jobId}/runs`)
      .send(body)
      .expect(202);
    await app.get(RunQueue).idle();
    return (await http.get(`/api/runs/${started.id}`).expect(200))
      .body as Record<string, unknown> & { id: string };
  };

  it('an incremental run only scans assets updated since the last successful run', async () => {
    const { id } = await createJob();
    const first = await run(id);
    expect(first).toMatchObject({
      fullRescan: true,
      since: null,
      scanned: 999,
      added: 97,
    });

    lib.assets = [...lib.assets, newScreenshot('IMG_9999.PNG')];
    const second = await run(id);
    expect(second).toMatchObject({
      status: 'succeeded',
      fullRescan: false,
      scanned: 1,
      matched: 1,
      added: 1,
    });
    expect(new Date(second.since as string).getTime()).toBe(
      new Date(first.startedAt as string).getTime(),
    );
    const lastSearch = immich.requestsTo('POST /search/metadata').at(-1)!
      .body as { filter: { updatedAt?: { gt: string } } };
    expect(lastSearch.filter.updatedAt?.gt).toBe(
      new Date(first.startedAt as string).toISOString(),
    );
    expect(lib.members('Screenshots')).toContain(uuid('IMG_9999.PNG'));

    const logs = (
      await http.get(`/api/runs/${second.id}/logs`).expect(200)
    ).body.map((l: { message: string }) => l.message);
    expect(logs).toContainEqual(
      expect.stringMatching(/^Incremental: only assets updated since /),
    );
  });

  it('reports the next scheduled run and keeps it in sync with job changes', async () => {
    const job = await createJob({ schedule: '0 3 * * *', enabled: true });
    expect(job.nextRunAt).toBeTruthy();
    expect([1, 2]).toContain(new Date(job.nextRunAt!).getUTCHours()); // 03:00 Europe/Berlin

    const disabled = await http
      .patch(`/api/jobs/${job.id}`)
      .send({ enabled: false })
      .expect(200);
    expect(disabled.body.nextRunAt).toBeNull();
    const res = await http
      .patch(`/api/jobs/${job.id}`)
      .send({ enabled: true, schedule: null })
      .expect(400);
    expect(res.body.errors).toEqual([
      {
        path: ['schedule'],
        message: 'is required when the schedule is enabled',
      },
    ]);
  });

  it('a scheduled run puts a newly uploaded screenshot into the album', async () => {
    const job = await createJob({ schedule: '* * * * * *', enabled: true }); // every second
    // Wait for the first scheduled (full) run to fill the album.
    await expect
      .poll(() => lib.members('Screenshots').length, {
        timeout: 15_000,
        interval: 200,
      })
      .toBe(97);

    lib.assets = [...lib.assets, newScreenshot('IMG_NEW.PNG')];
    await expect
      .poll(() => lib.members('Screenshots').includes(uuid('IMG_NEW.PNG')), {
        timeout: 15_000,
        interval: 200,
      })
      .toBe(true);

    await http
      .patch(`/api/jobs/${job.id}`)
      .send({ enabled: false })
      .expect(200);
    await app.get(RunQueue).idle();
    await sleep(1100); // no more ticks after disabling
    const runs = (
      await http.get(`/api/jobs/${job.id}/runs?limit=100`).expect(200)
    ).body.items as { trigger: string; fullRescan: boolean }[];
    expect(runs.every((r) => r.trigger === 'schedule')).toBe(true);
    expect(runs.at(-1)).toMatchObject({ fullRescan: true }); // first scheduled run was full
    expect(runs.filter((r) => !r.fullRescan).length).toBeGreaterThan(0); // later ones incremental
  }, 40_000);
});
