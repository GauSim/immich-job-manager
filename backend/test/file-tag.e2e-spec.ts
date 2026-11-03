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
const file = (name: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures/files', name));

describe('iOS tag from files (e2e)', () => {
  let immich: FakeImmichServer;
  let lib: FakeImmichLibrary;
  let dataDir: string;
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;

  /** iPhone screenshot whose Immich description was lost; only the file has the tag. */
  const hidden = {
    id: uuid('hidden-screenshot'),
    type: 'IMAGE',
    originalFileName: 'IMG_9001.PNG',
    originalMimeType: 'image/png',
    checksum: 'hidden-v1',
    width: 1024,
    height: 1536,
    exifInfo: { make: null, model: null, description: '' },
  };

  beforeEach(async () => {
    immich = await new FakeImmichServer().start();
    const sample = (
      JSON.parse(
        readFileSync(
          join(import.meta.dirname, 'fixtures/real-library-sample.json'),
          'utf8',
        ),
      ) as {
        id: string;
      }[]
    ).map((a) => ({ ...a, id: uuid(a.id), checksum: `sum-${a.id}` }));
    lib = new FakeImmichLibrary(immich, [...sample, hidden]);
    lib.defaultOriginal = file('png-without-tag.png');
    lib.originals.set(hidden.id, file('ios-screenshot.png'));
    dataDir = mkdtempSync(join(tmpdir(), 'iaj-tag-e2e-'));
    const config = loadConfig({
      IMMICH_URL: immich.url,
      IMMICH_API_KEY: 'k',
      APP_PASSWORD: 'p',
      AUTH_MODE: 'forward-auth', // auth is covered by auth.e2e-spec
      DATA_DIR: dataDir,
      MAX_FILE_READS: '4',
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

  const run = async (jobId: string) => {
    const { body } = await http
      .post(`/api/jobs/${jobId}/runs`)
      .send({ fullRescan: true }) // full scans: this test is about the file-tag cache
      .expect(202);
    await app.get(RunQueue).idle();
    return (await http.get(`/api/runs/${body.id}`).expect(200)).body as Record<
      string,
      number
    > & { id: string };
  };
  const reads = () =>
    immich.requestsMatching('GET', /^\/assets\/[^/]+\/original$/);

  it('finds a screenshot by its file tag, reads only borderline files, and a second run reads none', async () => {
    const { body: job } = await http
      .post('/api/jobs')
      .send({
        name: 'Screenshots',
        typeId: 'screenshot-detector',
        targetAlbumName: 'Screenshots',
        syncMode: 'additive',
      })
      .expect(201);

    const first = await run(job.id);
    expect(first).toMatchObject({
      status: 'succeeded',
      scanned: 1000,
      matched: 98,
      added: 98,
    });
    expect(lib.members('Screenshots')).toContain(hidden.id);
    // Only images without camera EXIF that don't already pass were read (not the 679 photos, not the 97 matches).
    expect(first.filesRead).toBe(reads().length);
    expect(first.filesRead).toBeGreaterThan(200);
    expect(first.filesRead).toBeLessThan(260);
    expect(
      reads().every((r) => /bytes=0-65535/.test(String(r.headers.range))),
    ).toBe(true);

    const second = await run(job.id);
    expect(second).toMatchObject({
      status: 'succeeded',
      matched: 98,
      added: 0,
      filesRead: 0,
      cacheHits: first.filesRead,
    });

    // The file changes (new checksum) → read again.
    lib.assets = lib.assets.map((a) =>
      a.id === hidden.id ? { ...a, checksum: 'hidden-v2' } : a,
    );
    const third = await run(job.id);
    expect(third).toMatchObject({
      filesRead: 1,
      cacheHits: first.filesRead - 1,
      matched: 98,
    });

    const candidates = await http
      .get(`/api/runs/${second.id}/logs`)
      .expect(200);
    expect(
      candidates.body.map((l: { message: string }) => l.message),
    ).toContainEqual(
      expect.stringMatching(/^iOS tag: 0 files read, \d+ from cache$/),
    );
  });
});
