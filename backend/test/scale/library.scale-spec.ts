import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.schema.js';
import { RunQueue } from '../../src/runner/run-queue.js';
import {
  FakeImmichLibrary,
  FakeImmichServer,
} from '../support/fake-immich-server.js';

/**
 * Phase 6 scale test: 100 copies of the anonymised real-library sample
 * (99,900 images) served by a fake Immich with sample originals, then two
 * full dry runs with the default screenshot params (iOS tag on).
 * Reports runtime, file reads and heap; asserts the second run reads ~nothing.
 */
const COPIES = Number(process.env.SCALE_COPIES ?? 100);
const uuid = (s: string) => {
  const h = createHash('sha1').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

describe('scale: 100k assets', () => {
  let immich: FakeImmichServer;
  let dataDir: string;
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let lib: FakeImmichLibrary;

  beforeAll(async () => {
    immich = await new FakeImmichServer().start();
    const sample = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '../fixtures/real-library-sample.json'),
        'utf8',
      ),
    ) as { id: string }[];
    const library = [];
    for (let c = 0; c < COPIES; c++) {
      for (const a of sample)
        library.push({
          ...a,
          id: uuid(`${c}-${a.id}`),
          checksum: `${c}-${a.id}`,
        });
    }
    lib = new FakeImmichLibrary(immich, library);
    lib.defaultOriginal = readFileSync(
      join(import.meta.dirname, '../fixtures/files/png-without-tag.png'),
    );
    dataDir = mkdtempSync(join(tmpdir(), 'iaj-scale-'));
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
    await app.init();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app?.close();
    await immich?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function measuredRun(jobId: string) {
    immich.requests.length = 0;
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    let peak = heapBefore;
    const sampler = setInterval(
      () => (peak = Math.max(peak, process.memoryUsage().heapUsed)),
      50,
    );
    const started = Date.now();
    const { body } = await http
      .post(`/api/jobs/${jobId}/runs`)
      .send({})
      .expect(202);
    await app.get(RunQueue).idle();
    clearInterval(sampler);
    const seconds = (Date.now() - started) / 1000;
    immich.requests.length = 0; // the fake server's request log is test overhead, not app memory
    global.gc?.();
    const retained = process.memoryUsage().heapUsed - heapBefore;
    const run = (await http.get(`/api/runs/${body.id}`).expect(200)).body;
    return { run, seconds, heapGrowth: peak - heapBefore, retained };
  }

  it('first run reads borderline files only; second run reads none', async () => {
    const { body: job } = await http
      .post('/api/jobs')
      .send({
        name: 'Scale',
        typeId: 'screenshot-detector',
        targetAlbumName: 'Scale',
      })
      .expect(201);

    const first = await measuredRun(job.id);
    const second = await measuredRun(job.id);
    // Every file changed (new checksums) → all borderline files are read again.
    lib.assets = lib.assets.map((a) => ({
      ...a,
      checksum: `${String(a.checksum)}-v2`,
    }));
    const third = await measuredRun(job.id);
    for (const [name, r] of [
      ['first', first],
      ['second', second],
      ['third', third],
    ] as const) {
      console.log(
        `${name} run: ${r.run.scanned} scanned, ${r.run.matched} matched, ${r.run.filesRead} files read, ` +
          `${r.run.cacheHits} cache hits, ${r.seconds.toFixed(1)} s, peak heap +${mb(r.heapGrowth)}, retained +${mb(r.retained)}`,
      );
    }

    expect(first.run).toMatchObject({
      status: 'succeeded',
      scanned: 999 * COPIES,
      matched: 97 * COPIES,
    });
    expect(second.run).toMatchObject({
      status: 'succeeded',
      matched: 97 * COPIES,
      filesRead: 0,
      cacheHits: first.run.filesRead,
    });
    expect(first.run.filesRead).toBeLessThan(first.run.scanned * 0.3); // only borderline images
    expect(second.seconds).toBeLessThan(first.seconds);
    expect(third.run).toMatchObject({
      filesRead: first.run.filesRead,
      cacheHits: 0,
    });
    // One page at a time: after warm-up (first run), a run that reads every borderline
    // file again retains nothing proportional to the library or the reads.
    expect(second.retained).toBeLessThan(32 * 1024 * 1024);
    expect(third.retained).toBeLessThan(32 * 1024 * 1024);
    expect(first.heapGrowth).toBeLessThan(384 * 1024 * 1024);
  });
});
