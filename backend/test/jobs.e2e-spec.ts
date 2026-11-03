import { mkdtempSync, rmSync } from 'node:fs';
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('Jobs & runs API (e2e)', () => {
  let immich: FakeImmichServer;
  let dataDir: string;
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    immich = await new FakeImmichServer().start();
    immich.on('GET /server/version', () => ({
      json: { major: 3, minor: 3, patch: 5 },
    }));
    dataDir = mkdtempSync(join(tmpdir(), 'iaj-jobs-e2e-'));
    const config = loadConfig({
      IMMICH_URL: immich.url,
      IMMICH_API_KEY: 'k',
      APP_PASSWORD: 'p',
      DATA_DIR: dataDir,
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

  const idle = () => app.get(RunQueue).idle();

  const createNoopJob = async (extra: Record<string, unknown> = {}) =>
    (
      await http
        .post('/api/jobs')
        .send({
          name: 'Noop',
          typeId: 'noop-test',
          targetAlbumName: 'Library',
          ...extra,
        })
        .expect(201)
    ).body as { id: string };

  it('lists job types with a JSON Schema for their params', async () => {
    const res = await http.get('/api/job-types').expect(200);
    const noop = (res.body as { id: string }[]).find(
      (t) => t.id === 'noop-test',
    );
    expect(noop).toMatchObject({
      name: 'No-op (test)',
      version: 1,
      defaultParams: {
        pageSize: 1000,
        imagesOnly: false,
        includeArchived: true,
      },
      paramsSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          pageSize: {
            type: 'integer',
            minimum: 1,
            maximum: 1000,
            default: 1000,
          },
        },
      },
    });
  });

  describe('jobs CRUD', () => {
    it('creates a job with defaults and lists it', async () => {
      const job = await createNoopJob({ params: { pageSize: 50 } });
      expect(job).toMatchObject({
        name: 'Noop',
        typeId: 'noop-test',
        params: { pageSize: 50, imagesOnly: false, includeArchived: true },
        syncMode: 'dry-run',
        schedule: null,
        enabled: false,
        targetAlbumName: 'Library',
        exclusionAlbumName: null,
        effectiveExclusionAlbumName: 'Library – excluded',
        lastRun: null,
      });
      const list = await http.get('/api/jobs').expect(200);
      expect(list.body).toHaveLength(1);
    });

    it('returns field errors', async () => {
      const res = await http
        .post('/api/jobs')
        .send({
          name: '',
          typeId: 'noop-test',
          schedule: 'every day',
          extra: 1,
        })
        .expect(400);
      expect(res.body.message).toBe('Validation failed');
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          { path: ['name'], message: 'is required' },
          { path: ['targetAlbumName'], message: expect.any(String) },
          {
            path: ['schedule'],
            message: 'must be a valid cron expression, e.g. "0 3 * * *"',
          },
          {
            path: [],
            message: expect.stringMatching(/Unrecognized key.*extra/),
          },
        ]),
      );
    });

    it('validates the type and its params', async () => {
      const unknown = await http
        .post('/api/jobs')
        .send({ name: 'x', typeId: 'nope', targetAlbumName: 'A' })
        .expect(400);
      expect(unknown.body.errors).toEqual([
        { path: ['typeId'], message: 'unknown job type "nope"' },
      ]);
      const bad = await http
        .post('/api/jobs')
        .send({
          name: 'x',
          typeId: 'noop-test',
          targetAlbumName: 'A',
          params: { pageSize: 0 },
        })
        .expect(400);
      expect(bad.body.errors).toEqual([
        { path: ['params', 'pageSize'], message: expect.stringMatching(/>=1/) },
      ]);
    });

    it('updates and deletes a job', async () => {
      const { id } = await createNoopJob();
      const res = await http
        .patch(`/api/jobs/${id}`)
        .send({
          name: 'Renamed',
          schedule: '0 3 * * *',
          params: { imagesOnly: true },
          exclusionAlbumName: 'Skip',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        name: 'Renamed',
        schedule: '0 3 * * *',
        params: { pageSize: 1000, imagesOnly: true },
        effectiveExclusionAlbumName: 'Skip',
      });
      await http.patch(`/api/jobs/${id}`).send({ typeId: 'other' }).expect(400);
      await http.delete(`/api/jobs/${id}`).expect(204);
      await http.get(`/api/jobs/${id}`).expect(404);
    });

    it('rejects malformed ids', async () => {
      await http.get('/api/jobs/not-a-uuid').expect(400);
      await http
        .get('/api/runs/00000000-0000-4000-8000-000000000000')
        .expect(404);
    });
  });

  describe('runs', () => {
    it('runs a noop job over the whole library and reports the scanned count', async () => {
      serveLibrary(immich, 2500);
      const { id } = await createNoopJob();
      const started = await http
        .post(`/api/jobs/${id}/runs`)
        .send({})
        .expect(202);
      expect(started.body).toMatchObject({
        jobId: id,
        dryRun: true,
        fullRescan: true,
        trigger: 'manual',
      });
      await idle();

      const run = await http.get(`/api/runs/${started.body.id}`).expect(200);
      expect(run.body).toMatchObject({
        status: 'succeeded',
        scanned: 2500,
        matched: 0,
        cursor: null,
      });
      expect(immich.requestsTo('POST /search/metadata')).toHaveLength(3);
      expect(immich.requestsTo('POST /search/metadata')[0].body).toMatchObject({
        filter: { visibility: { in: ['timeline', 'archive'] } },
        size: 1000,
      });

      const runs = await http.get(`/api/jobs/${id}/runs`).expect(200);
      expect(runs.body).toMatchObject({
        total: 1,
        items: [{ id: started.body.id }],
      });
      const job = await http.get(`/api/jobs/${id}`).expect(200);
      expect(job.body.lastRun).toMatchObject({
        id: started.body.id,
        status: 'succeeded',
      });

      const logs = await http
        .get(`/api/runs/${started.body.id}/logs`)
        .expect(200);
      expect(logs.body.map((l: { message: string }) => l.message)).toEqual([
        expect.stringMatching(/^Starting dry run of "Noop" \(noop-test v1\)/),
        'Full scan of the library',
        'Album "Library": does not exist yet; exclusion album "Library – excluded": does not exist yet',
        expect.stringMatching(/^Finished: 2500 scanned, 0 matched/),
      ]);
      const after = await http
        .get(`/api/runs/${started.body.id}/logs?after=${logs.body[0].id}`)
        .expect(200);
      expect(after.body).toHaveLength(3);
    });

    it('allows one active run per job and guards dry-run jobs', async () => {
      serveLibrary(immich, 3000, { beforePage: () => sleep(50) });
      const { id } = await createNoopJob();
      await http
        .post(`/api/jobs/${id}/runs`)
        .send({ dryRun: false })
        .expect(400);
      await http.post(`/api/jobs/${id}/runs`).send({}).expect(202);
      await http.post(`/api/jobs/${id}/runs`).send({}).expect(409);
      await http.delete(`/api/jobs/${id}`).expect(409);
      await idle();
      await http.post(`/api/jobs/${id}/runs`).send({}).expect(202);
      await idle();
    });

    it('cancels a running run', async () => {
      serveLibrary(immich, 10_000, { beforePage: () => sleep(30) });
      const { id } = await createNoopJob();
      const { body } = await http
        .post(`/api/jobs/${id}/runs`)
        .send({})
        .expect(202);
      await sleep(80);
      await http.post(`/api/runs/${body.id}/cancel`).expect(202);
      await idle();
      const run = await http.get(`/api/runs/${body.id}`).expect(200);
      expect(run.body.status).toBe('cancelled');
      expect(run.body.scanned).toBeGreaterThan(0);
      expect(run.body.scanned).toBeLessThan(10_000);
      await http.post(`/api/runs/${body.id}/cancel`).expect(409);
      await http.post(`/api/runs/${body.id}/resume`).expect(409);
    });

    it('resumes a failed run from its cursor', async () => {
      let failOnce = true;
      serveLibrary(immich, 2500, {
        beforePage: (offset) => {
          if (offset === 2000 && failOnce) {
            failOnce = false;
            return {
              status: 400,
              json: {
                message: 'Validation failed',
                errors: [{ path: ['cursor'], message: 'bad' }],
              },
            };
          }
        },
      });
      const { id } = await createNoopJob();
      const { body } = await http
        .post(`/api/jobs/${id}/runs`)
        .send({})
        .expect(202);
      await idle();
      const failed = await http.get(`/api/runs/${body.id}`).expect(200);
      expect(failed.body).toMatchObject({ status: 'failed', scanned: 2000 });
      expect(failed.body.error).toMatch(
        /HTTP 400: Validation failed \(cursor: bad\) \(correlation id corr-\d+\)/,
      );

      await http.post(`/api/runs/${body.id}/resume`).expect(202);
      await idle();
      const done = await http.get(`/api/runs/${body.id}`).expect(200);
      expect(done.body).toMatchObject({
        status: 'succeeded',
        scanned: 2500,
        error: null,
      });
      // Only the failed page was requested again.
      const offsets = immich.requestsTo('POST /search/metadata').map((r) => {
        const cursor = (r.body as { cursor?: string }).cursor;
        return cursor
          ? (
              JSON.parse(Buffer.from(cursor, 'base64').toString()) as {
                offset: number;
              }
            ).offset
          : 0;
      });
      expect(offsets).toEqual([0, 1000, 2000, 2000]); // pages 1–2, failed page 3, page 3 again on resume
    });

    it('streams progress, logs and the final status over SSE', async () => {
      serveLibrary(immich, 3000, { beforePage: () => sleep(20) });
      const { id } = await createNoopJob({ params: { pageSize: 100 } });
      const { body } = await http
        .post(`/api/jobs/${id}/runs`)
        .send({})
        .expect(202);
      const res = await http
        .get(`/api/runs/${body.id}/events`)
        .buffer(true)
        .parse((r, cb) => {
          let text = '';
          r.on('data', (c: Buffer) => (text += c.toString()));
          r.on('end', () => cb(null, text));
        });
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);
      const events = String(res.body)
        .trim()
        .split('\n\n')
        .filter((b) => b.startsWith('event:'))
        .map((b) => ({
          type: b.split('\n')[0].slice(7),
          data: JSON.parse(b.split('\n')[1].slice(6)),
        }));
      expect(events[0].type).toBe('status');
      expect(events.some((e) => e.type === 'log')).toBe(true);
      expect(
        events.filter((e) => e.type === 'progress').length,
      ).toBeGreaterThan(0);
      expect(events.at(-1)).toEqual({
        type: 'status',
        data: expect.objectContaining({ status: 'succeeded', scanned: 3000 }),
      });
    });

    it('sends a single status event for finished runs', async () => {
      serveLibrary(immich, 5);
      const { id } = await createNoopJob();
      const { body } = await http
        .post(`/api/jobs/${id}/runs`)
        .send({})
        .expect(202);
      await idle();
      const res = await http.get(`/api/runs/${body.id}/events`).expect(200);
      expect(res.text).toBe(
        `event: status\ndata: ${JSON.stringify({ status: 'succeeded', error: null, scanned: 5, matched: 0, added: 0, removed: 0, filesRead: 0, cacheHits: 0 })}\n\n`,
      );
    });

    it('fails a run when Immich is not v3', async () => {
      serveLibrary(immich, 5);
      const { id } = await createNoopJob();
      immich.on('GET /server/version', () => ({
        json: { major: 4, minor: 0, patch: 0 },
      }));
      const { body } = await http
        .post(`/api/jobs/${id}/runs`)
        .send({})
        .expect(202);
      await idle();
      const run = await http.get(`/api/runs/${body.id}`).expect(200);
      expect(run.body).toMatchObject({
        status: 'failed',
        error: expect.stringMatching(/v4.0.0 is not supported/),
      });
    });
  });
});
