import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { AssetIndexService } from '../../src/asset-index/asset-index.service.js';
import { loadConfig } from '../../src/config/config.schema.js';
import { detectTrips } from '../../src/jobs/trips/detect.js';
import { DEFAULT_TRIP_PARAMS } from '../../src/jobs/trips/trip.params.js';
import { RunQueue } from '../../src/runner/run-queue.js';
import {
  FakeImmichLibrary,
  FakeImmichServer,
} from '../support/fake-immich-server.js';
import { PLACES, Timeline } from '../support/timeline.js';
import { toImmich } from '../support/trip-library.js';

/**
 * Trip albums phase T6 scale test: ~100k photos over 10 years (Berlin home,
 * a week abroad every ~2 months = 60 trips), one full trip dry run through
 * the app (index refresh + detection + reconcile), plus detection alone over
 * the index. Reports runtime and heap.
 */
const TRIPS = 60;
const PER_DAY = 26;
const DESTINATIONS = [
  PLACES.bangkok,
  PLACES.prague,
  PLACES.siemReap,
  PLACES.amsterdam,
];
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

function library(): Timeline {
  const t = new Timeline('me');
  const start = Date.UTC(2016, 0, 1);
  for (let d = 0; d < 3650; d++) {
    const day = new Date(start + d * 86_400_000).toISOString().slice(0, 10);
    // Trip n: days 60n+30 … 60n+36.
    const n = Math.floor((d - 30) / 60);
    const away = d >= 30 && n < TRIPS && (d - 30) % 60 < 7;
    const place = away
      ? DESTINATIONS[n % DESTINATIONS.length]
      : PLACES.berlinHome;
    for (let i = 0; i < PER_DAY; i++) {
      const minutes = 8 * 60 + Math.floor((i * 13 * 60) / PER_DAY);
      const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
      const mm = String(minutes % 60).padStart(2, '0');
      t.shot(`${day}T${hh}:${mm}`, place);
    }
  }
  return t;
}

describe('scale: trip albums over ~100k assets', () => {
  let immich: FakeImmichServer;
  let dataDir: string;
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let total = 0;

  beforeAll(async () => {
    const t = library();
    total = t.assets.length;
    immich = await new FakeImmichServer().start();
    new FakeImmichLibrary(immich, t.assets.map(toImmich));
    immich.on('GET /users/me', () => ({ json: { id: 'me' } }));
    dataDir = mkdtempSync(join(tmpdir(), 'iaj-trip-scale-'));
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

  afterAll(async () => {
    await app?.close();
    await immich?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('dry-runs the trip job and detects every trip', async () => {
    const job = (
      await http
        .post('/api/jobs')
        .send({ name: 'Trips', typeId: 'trip-albums' })
        .expect(201)
    ).body as { id: string };

    const t0 = Date.now();
    const run = (
      await http
        .post(`/api/jobs/${job.id}/runs`)
        .send({ dryRun: true })
        .expect(202)
    ).body as { id: string };
    await app.get(RunQueue).idle();
    const runMs = Date.now() - t0;
    const done = (await http.get(`/api/runs/${run.id}`).expect(200)).body as {
      status: string;
      scanned: number;
    };
    expect(done).toMatchObject({ status: 'succeeded', scanned: total });
    const groups = (await http.get(`/api/runs/${run.id}/groups`).expect(200))
      .body as { items: unknown[] };
    expect(groups.items).toHaveLength(TRIPS);

    // Detection alone, over the index as the job reads it.
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const t1 = Date.now();
    const reader = app.get(AssetIndexService).read({ ownerId: 'me' });
    const readMs = Date.now() - t1;
    const t2 = Date.now();
    const { trips } = detectTrips({
      assets: reader.all(),
      ownerId: 'me',
      params: DEFAULT_TRIP_PARAMS,
      now: new Date('2026-06-01T00:00:00Z'),
    });
    const detectMs = Date.now() - t2;
    const peak = process.memoryUsage().heapUsed - before;
    expect(trips).toHaveLength(TRIPS);

    console.log(
      `trip scale: ${total} assets · dry run ${(runMs / 1000).toFixed(1)} s ` +
        `(index refresh + detection + reconcile) · index read ${readMs} ms · detection ${detectMs} ms · ` +
        `heap for reader + detection ≈ ${mb(peak)}`,
    );
    // Generous bounds: catch accidental quadratic behaviour, not CI noise.
    expect(detectMs).toBeLessThan(30_000);
    expect(runMs).toBeLessThan(180_000);
  });
});
