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
import { SqliteService } from '../src/persistence/sqlite.service.js';
import {
  FakeImmichLibrary,
  FakeImmichServer,
} from './support/fake-immich-server.js';

const uuid = (s: string) => {
  const h = createHash('sha1').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
type Fixture = Record<string, unknown> & { id: string; label: string };
const loadSample = () =>
  (
    JSON.parse(
      readFileSync(
        join(import.meta.dirname, 'fixtures/real-library-sample.json'),
        'utf8',
      ),
    ) as Fixture[]
  ).map((a) => ({ ...a, id: uuid(a.id) }));

describe('Album sync (e2e)', () => {
  let immich: FakeImmichServer;
  let lib: FakeImmichLibrary;
  let dataDir: string;
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let sample: Fixture[];
  let screenshots: string[];

  beforeEach(async () => {
    immich = await new FakeImmichServer().start();
    sample = loadSample();
    screenshots = sample
      .filter((a) => a.label === 'screenshot')
      .map((a) => a.id);
    lib = new FakeImmichLibrary(immich, sample);
    dataDir = mkdtempSync(join(tmpdir(), 'iaj-sync-e2e-'));
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

  afterEach(async () => {
    await app.close();
    await immich.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const idle = () => app.get(RunQueue).idle();
  const createJob = async (body: Record<string, unknown> = {}) =>
    (
      await http
        .post('/api/jobs')
        .send({
          name: 'Screenshots',
          typeId: 'screenshot-detector',
          targetAlbumName: 'Screenshots',
          ...body,
        })
        .expect(201)
    ).body as { id: string };
  const runJob = async (jobId: string, dryRun?: boolean) => {
    const { body } = await http
      .post(`/api/jobs/${jobId}/runs`)
      .send(dryRun === undefined ? {} : { dryRun })
      .expect(202);
    await idle();
    return (await http.get(`/api/runs/${body.id}`).expect(200)).body as Record<
      string,
      unknown
    > & { id: string };
  };
  const owned = (jobId: string) =>
    app
      .get(SqliteService)
      .db.prepare('SELECT COUNT(*) AS n FROM job_asset WHERE job_id = ?')
      .get(jobId) as { n: number };

  it('fills the album with an additive run, and a rerun makes zero writes', async () => {
    const { id } = await createJob({ syncMode: 'additive' });
    const first = await runJob(id);
    expect(first).toMatchObject({
      status: 'succeeded',
      dryRun: false,
      scanned: 999,
      matched: 97,
      added: 97,
      removed: 0,
    });
    expect(lib.members('Screenshots')).toHaveLength(97);
    expect(lib.members('Screenshots')).toEqual(
      expect.arrayContaining(screenshots),
    );
    expect(lib.album('Screenshots – excluded')).toBeDefined();
    expect(owned(id).n).toBe(97);
    expect(lib.writeCalls()).toBe(1); // one page with matches → one PUT (≤ 500 ids)

    const second = await runJob(id);
    expect(second).toMatchObject({
      status: 'succeeded',
      matched: 97,
      added: 0,
      removed: 0,
    });
    expect(lib.writeCalls()).toBe(1);
    expect(immich.requestsTo('POST /albums')).toHaveLength(2); // not created again
  });

  it('keeps an asset out once it is moved to the exclusion album', async () => {
    const { id } = await createJob({ syncMode: 'additive' });
    await runJob(id);
    const moved = screenshots[0];
    lib.album('Screenshots')!.members.delete(moved);
    lib.album('Screenshots – excluded')!.members.add(moved);

    const next = await runJob(id);
    expect(next).toMatchObject({ matched: 96, added: 0 });
    expect(lib.members('Screenshots')).not.toContain(moved);
    expect(lib.writeCalls()).toBe(1);
  });

  it('mirror mode removes owned non-matches and keeps assets added by hand', async () => {
    const { id } = await createJob({ syncMode: 'mirror' });
    await runJob(id);
    const manual = sample.find((a) => a.label === 'photo')!.id;
    lib.album('Screenshots')!.members.add(manual); // added by the user in Immich

    // One screenshot loses all its signals (e.g. metadata corrected) → no longer a match.
    const changed = screenshots[1];
    lib.assets = lib.assets.map((a) =>
      a.id === changed
        ? {
            ...a,
            originalMimeType: 'image/jpeg',
            width: 4000,
            height: 3000,
            exifInfo: { make: 'Apple', model: 'X', description: '' },
          }
        : a,
    );
    const next = await runJob(id);
    expect(next).toMatchObject({
      status: 'succeeded',
      matched: 96,
      added: 0,
      removed: 1,
    });
    expect(lib.members('Screenshots')).not.toContain(changed);
    expect(lib.members('Screenshots')).toContain(manual);
    expect(owned(id).n).toBe(96);
  });

  it('dry runs change nothing in Immich', async () => {
    const { id } = await createJob();
    const run = await runJob(id);
    expect(run).toMatchObject({ dryRun: true, matched: 97, added: 0 });
    expect(immich.requestsTo('POST /albums')).toHaveLength(0);
    expect(lib.writeCalls()).toBe(0);
  });

  describe('apply a dry run', () => {
    it('previews, then adds only the selected candidates', async () => {
      const { id } = await createJob();
      const dry = await runJob(id);
      const unticked = (
        await http
          .get(`/api/runs/${dry.id}/candidates?maxScore=0.8`)
          .expect(200)
      ).body.items[0].assetId;
      await http
        .patch(`/api/runs/${dry.id}/candidates`)
        .send({ selected: false, assetIds: [unticked] })
        .expect(200);

      const preview = await http
        .get(`/api/runs/${dry.id}/apply-preview`)
        .expect(200);
      expect(preview.body).toEqual({
        albumName: 'Screenshots',
        albumExists: false,
        exclusionAlbumName: 'Screenshots – excluded',
        selected: 96,
        alreadyInAlbum: 0,
        excluded: 0,
        toAdd: 96,
      });
      expect(immich.requestsTo('POST /albums')).toHaveLength(0); // preview is read-only

      const applied = await http.post(`/api/runs/${dry.id}/apply`).expect(200);
      expect(applied.body).toMatchObject({
        albumName: 'Screenshots',
        albumCreated: true,
        selected: 96,
        added: 96,
        alreadyInAlbum: 0,
      });
      expect(lib.members('Screenshots')).toHaveLength(96);
      expect(lib.members('Screenshots')).not.toContain(unticked);
      expect(owned(id).n).toBe(96);
      const run = (await http.get(`/api/runs/${dry.id}`).expect(200)).body;
      expect(run).toMatchObject({ added: 96 });
      expect(run.appliedAt).toBeTruthy();

      // Idempotent: applying again writes nothing.
      const again = await http.post(`/api/runs/${dry.id}/apply`).expect(200);
      expect(again.body).toMatchObject({ added: 0, alreadyInAlbum: 96 });
      expect(lib.writeCalls()).toBe(1);
      expect(
        (await http.get(`/api/runs/${dry.id}/apply-preview`).expect(200)).body,
      ).toMatchObject({
        albumExists: true,
        toAdd: 0,
        alreadyInAlbum: 96,
      });
    });

    it('respects the exclusion album', async () => {
      const { id } = await createJob();
      const dry = await runJob(id);
      lib.addAlbum('Screenshots – excluded', [screenshots[0]]);
      const preview = (
        await http.get(`/api/runs/${dry.id}/apply-preview`).expect(200)
      ).body;
      expect(preview).toMatchObject({ selected: 97, excluded: 1, toAdd: 96 });
      const applied = (await http.post(`/api/runs/${dry.id}/apply`).expect(200))
        .body;
      expect(applied).toMatchObject({ added: 96, excluded: 1 });
    });

    it('refuses real runs, unfinished runs and busy jobs', async () => {
      const { id } = await createJob({ syncMode: 'additive' });
      const real = await runJob(id);
      await http.post(`/api/runs/${real.id}/apply`).expect(409);
      const dry = await runJob(id, true);

      // Make the next real run slow, then try to apply while it runs.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      immich.on('POST /search/metadata', async (req) => {
        await gate;
        lib.assets = sample;
        return (
          lib as unknown as { search(r: typeof req): { json: unknown } }
        ).search(req);
      });
      await http.post(`/api/jobs/${id}/runs`).send({}).expect(202);
      await http.post(`/api/runs/${dry.id}/apply`).expect(409);
      release();
      await idle();
    });
  });

  it('rejects an exclusion album equal to the target album', async () => {
    const res = await http
      .post('/api/jobs')
      .send({
        name: 'x',
        typeId: 'screenshot-detector',
        targetAlbumName: 'A',
        exclusionAlbumName: 'a',
      })
      .expect(400);
    expect(res.body.errors).toEqual([
      {
        path: ['exclusionAlbumName'],
        message: 'must differ from the target album',
      },
    ]);
  });
});
