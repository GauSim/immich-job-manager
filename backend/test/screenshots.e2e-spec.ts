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
  FakeImmichServer,
  serveLibrary,
} from './support/fake-immich-server.js';

/** Deterministic UUID from a string (fixture ids are not UUIDs). */
const uuid = (s: string) => {
  const h = createHash('sha1').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

type Fixture = Record<string, unknown> & { id: string; label: string };
const sample = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, 'fixtures/real-library-sample.json'),
      'utf8',
    ),
  ) as Fixture[]
).map((a) => ({ ...a, id: uuid(a.id) }));

describe('Screenshot job dry run & review (e2e)', () => {
  let immich: FakeImmichServer;
  let dataDir: string;
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    immich = await new FakeImmichServer().start();
    immich.on('GET /server/version', () => ({
      json: { major: 3, minor: 3, patch: 5 },
    }));
    dataDir = mkdtempSync(join(tmpdir(), 'iaj-shots-e2e-'));
    const config = loadConfig({
      IMMICH_URL: immich.url,
      IMMICH_API_KEY: 'k',
      APP_PASSWORD: 'p',
      AUTH_MODE: 'forward-auth', // auth is covered by auth.e2e-spec
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

  const dryRun = async (params: Record<string, unknown> = {}) => {
    const job = await http
      .post('/api/jobs')
      .send({
        name: 'Screenshots',
        typeId: 'screenshot-detector',
        targetAlbumName: 'Screenshots',
        params,
      })
      .expect(201);
    const run = await http
      .post(`/api/jobs/${job.body.id}/runs`)
      .send({})
      .expect(202);
    await app.get(RunQueue).idle();
    return { jobId: job.body.id as string, runId: run.body.id as string };
  };

  it('scores a real library sample and offers the candidates for review', async () => {
    serveLibrary(immich, sample);
    const { runId } = await dryRun();

    const run = await http.get(`/api/runs/${runId}`).expect(200);
    expect(run.body).toMatchObject({
      status: 'succeeded',
      scanned: 999,
      matched: 97,
    });
    expect(immich.requestsTo('POST /search/metadata')[0].body).toMatchObject({
      filter: { type: { eq: 'IMAGE' }, visibility: { in: ['timeline'] } },
      withExif: true,
    });

    const list = await http
      .get(`/api/runs/${runId}/candidates?limit=5`)
      .expect(200);
    expect(list.body.total).toBe(97);
    expect(list.body.summary).toEqual({
      all: 97,
      selected: 97,
      unselected: 0,
      high: 96,
      medium: 1,
    });
    expect(list.body.items).toHaveLength(5);
    expect(list.body.items[0]).toMatchObject({
      score: 1,
      selected: true,
      reasons: expect.arrayContaining(['description-tag']),
      originalFileName: expect.stringMatching(/\.(PNG|png|JPG)$/),
    });

    const band = await http
      .get(`/api/runs/${runId}/candidates?minScore=0.6&maxScore=0.8`)
      .expect(200);
    expect(band.body.items).toEqual([
      expect.objectContaining({
        score: 0.6,
        reasons: ['png', 'no-camera-exif', 'screen-size'],
      }),
    ]);

    const byName = await http
      .get(`/api/runs/${runId}/candidates?sort=name&limit=200`)
      .expect(200);
    const names = byName.body.items.map((c: { originalFileName: string }) =>
      c.originalFileName.toLowerCase(),
    );
    expect(names).toEqual(
      [...names].sort((a: string, b: string) => a.localeCompare(b, 'en')),
    );

    const logs = await http.get(`/api/runs/${runId}/logs`).expect(200);
    expect(logs.body.map((l: { message: string }) => l.message)).toContainEqual(
      expect.stringMatching(/^Matches by signal: .*description-tag 96/),
    );
  });

  it('ticks and unticks candidates by id and by filter', async () => {
    serveLibrary(immich, sample);
    const { runId } = await dryRun();
    const low = (
      await http.get(`/api/runs/${runId}/candidates?maxScore=0.8`).expect(200)
    ).body.items[0].assetId;

    const byId = await http
      .patch(`/api/runs/${runId}/candidates`)
      .send({ selected: false, assetIds: [low, low] })
      .expect(200);
    expect(byId.body).toEqual({
      updated: 1,
      summary: expect.objectContaining({ selected: 96, unselected: 1 }),
    });
    const unticked = await http
      .get(`/api/runs/${runId}/candidates?selected=false`)
      .expect(200);
    expect(
      unticked.body.items.map((c: { assetId: string }) => c.assetId),
    ).toEqual([low]);

    const byFilter = await http
      .patch(`/api/runs/${runId}/candidates`)
      .send({ selected: false, filter: { minScore: 0.8 } })
      .expect(200);
    expect(byFilter.body.summary).toMatchObject({
      selected: 0,
      unselected: 97,
    });

    const all = await http
      .patch(`/api/runs/${runId}/candidates`)
      .send({ selected: true })
      .expect(200);
    expect(all.body).toMatchObject({ updated: 97, summary: { selected: 97 } });

    await http
      .patch(`/api/runs/${runId}/candidates`)
      .send({ selected: true, assetIds: [low], filter: {} })
      .expect(400);
  });

  it('applies job params (threshold) to the dry run', async () => {
    serveLibrary(immich, sample);
    const { runId } = await dryRun({ threshold: 1 });
    expect(
      (await http.get(`/api/runs/${runId}`).expect(200)).body.matched,
    ).toBe(96);
  });

  it('has no candidates to review for real runs', async () => {
    serveLibrary(immich, sample.slice(0, 50));
    const job = await http
      .post('/api/jobs')
      .send({
        name: 'S',
        typeId: 'screenshot-detector',
        targetAlbumName: 'S',
        syncMode: 'additive',
      })
      .expect(201);
    const run = await http
      .post(`/api/jobs/${job.body.id}/runs`)
      .send({})
      .expect(202);
    expect(run.body.dryRun).toBe(false);
    await app.get(RunQueue).idle();
    const list = await http
      .get(`/api/runs/${run.body.id}/candidates`)
      .expect(200);
    expect(list.body).toMatchObject({ total: 0, items: [] });
    await http
      .patch(`/api/runs/${run.body.id}/candidates`)
      .send({ selected: false })
      .expect(409);
  });

  describe('thumbnail proxy', () => {
    it('serves thumbnails of assets seen in a run, and nothing else', async () => {
      serveLibrary(immich, sample);
      const { runId } = await dryRun();
      const known = (
        await http.get(`/api/runs/${runId}/candidates?limit=1`).expect(200)
      ).body.items[0].assetId;
      immich.on(`GET /assets/${known}/thumbnail`, (_req, res) => {
        res.writeHead(200, {
          'content-type': 'image/webp',
          'content-length': '4',
        });
        res.end(Buffer.from([1, 2, 3, 4]));
      });

      const res = await http.get(`/api/assets/${known}/thumbnail`).expect(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toBe('private, max-age=86400');
      expect([...res.body]).toEqual([1, 2, 3, 4]);

      // Not part of any run → never proxied, Immich not asked.
      const stranger = sample.find((a) => a.label === 'photo')!.id;
      await http.get(`/api/assets/${stranger}/thumbnail`).expect(404);
      expect(
        immich.requestsTo(`GET /assets/${stranger}/thumbnail`),
      ).toHaveLength(0);
      await http.get('/api/assets/not-a-uuid/thumbnail').expect(400);
    });

    it('maps a missing asset in Immich to 404', async () => {
      serveLibrary(immich, sample);
      const { runId } = await dryRun();
      const known = (
        await http.get(`/api/runs/${runId}/candidates?limit=1`).expect(200)
      ).body.items[0].assetId;
      immich.on(`GET /assets/${known}/thumbnail`, () => ({
        status: 404,
        json: { message: 'Not found' },
      }));
      await http.get(`/api/assets/${known}/thumbnail`).expect(404);
    });
  });

  it('dry-runs 30,000 assets in pages of 1,000', async () => {
    const big = Array.from({ length: 30 }, (_, copy) =>
      sample.map((a) => ({ ...a, id: uuid(`${copy}-${a.id}`) })),
    ).flat(); // 29,970 assets
    serveLibrary(immich, big);
    const started = Date.now();
    const { runId } = await dryRun();
    const seconds = (Date.now() - started) / 1000;
    const run = (await http.get(`/api/runs/${runId}`).expect(200)).body;
    expect(run).toMatchObject({
      status: 'succeeded',
      scanned: 29_970,
      matched: 97 * 30,
    });
    expect(immich.requestsTo('POST /search/metadata')).toHaveLength(30);
    expect(seconds).toBeLessThan(30);
  }, 60_000);
});
