import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { IndexedAsset } from '../src/asset-index/asset-index.mapping.js';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.schema.js';
import { RunQueue } from '../src/runner/run-queue.js';
import {
  FakeImmichLibrary,
  FakeImmichServer,
} from './support/fake-immich-server.js';
import { PLACES, Timeline } from './support/timeline.js';
import { toImmich } from './support/trip-library.js';

/** Home in Berlin; Bangkok 2026-03-04 … 03-18 and Prague 2026-05-01 … 05-03. */
function library() {
  const t = new Timeline('me');
  t.days('2026-01-01', '2026-03-03', PLACES.berlinHome);
  t.days('2026-03-04', '2026-03-18', PLACES.bangkok);
  t.days('2026-03-19', '2026-04-30', PLACES.berlinHome);
  t.days('2026-05-01', '2026-05-03', PLACES.prague);
  t.days('2026-05-04', '2026-06-30', PLACES.berlinHome);
  return t.assets;
}

const THAI = 'Thailand – Mar 2026';
const CZ = 'Czechia – May 2026';

describe('Trip albums: album sync and apply (e2e)', () => {
  let immich: FakeImmichServer;
  let lib: FakeImmichLibrary;
  let assets: IndexedAsset[];
  let dataDir: string;
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    assets = library();
    immich = await new FakeImmichServer().start();
    lib = new FakeImmichLibrary(immich, assets.map(toImmich));
    immich.on('GET /users/me', () => ({ json: { id: 'me' } }));
    dataDir = mkdtempSync(join(tmpdir(), 'iaj-trip-sync-e2e-'));
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

  const createJob = async (extra: Record<string, unknown> = {}) =>
    (
      await http
        .post('/api/jobs')
        .send({ name: 'Trips', typeId: 'trip-albums', ...extra })
        .expect(201)
    ).body as { id: string };

  const run = async (jobId: string, dryRun: boolean) => {
    const r = (
      await http.post(`/api/jobs/${jobId}/runs`).send({ dryRun }).expect(202)
    ).body as { id: string };
    await idle();
    return (await http.get(`/api/runs/${r.id}`).expect(200)).body as {
      id: string;
      status: string;
      error: string | null;
      added: number;
      removed: number;
      matched: number;
    };
  };

  const realRun = async (jobId: string) => {
    const r = await run(jobId, false);
    expect(r).toMatchObject({ status: 'succeeded', error: null });
    return r;
  };

  const tripAssets = (from: string, to: string) =>
    assets
      .filter(
        (a) =>
          a.localDateTime.slice(0, 10) >= from &&
          a.localDateTime.slice(0, 10) <= to &&
          a.latitude !== null,
      )
      .map((a) => a.id);

  const storedGroups = async (jobId: string) =>
    (await http.get(`/api/jobs/${jobId}/groups`).expect(200)).body as {
      id: string;
      status: string;
      name: string;
      albumId: string | null;
      nameLocked: boolean;
      adopted: boolean;
      assetCount: number;
      excludedCount: number;
    }[];

  const additive = { syncMode: 'additive' };

  describe('real runs', () => {
    it('create one album per trip and change nothing on a rerun', async () => {
      const job = await createJob(additive);
      const first = await realRun(job.id);

      const thai = lib.album(THAI);
      const cz = lib.album(CZ);
      expect(thai?.description).toBe('Managed by Immich Album Jobs – Trips');
      expect(lib.members(THAI)).toEqual(
        expect.arrayContaining(tripAssets('2026-03-04', '2026-03-18')),
      );
      expect(lib.members(CZ)).toEqual(
        expect.arrayContaining(tripAssets('2026-05-01', '2026-05-03')),
      );
      expect(lib.album('Trips – excluded')).toBeDefined();
      expect(first.added).toBe(thai!.members.size + cz!.members.size);

      const groups = await storedGroups(job.id);
      expect(groups.map((g) => [g.name, g.status])).toEqual([
        [THAI, 'active'],
        [CZ, 'active'],
      ]);

      const writes = lib.allAlbumWrites();
      const second = await realRun(job.id);
      expect(lib.allAlbumWrites()).toBe(writes);
      expect(second).toMatchObject({ added: 0, removed: 0 });
    });

    it('respect manual edits: renamed albums, removed and added photos', async () => {
      const job = await createJob(additive);
      await realRun(job.id);
      const thai = lib.album(THAI)!;
      const removedByHand = [...thai.members][0];
      const homePhoto = tripAssets('2026-02-01', '2026-02-01')[0];
      thai.members.delete(removedByHand);
      thai.members.add(homePhoto);
      thai.albumName = 'Bangkok with friends';

      await realRun(job.id);
      expect(thai.albumName).toBe('Bangkok with friends');
      expect(thai.members.has(removedByHand)).toBe(false);
      expect(thai.members.has(homePhoto)).toBe(true);
      const [g] = await storedGroups(job.id);
      expect(g).toMatchObject({ nameLocked: true, excludedCount: 1 });

      // A new name template renames albums the user did not rename.
      await http
        .patch(`/api/jobs/${job.id}`)
        .send({ params: { nameTemplate: '{country} {year}' } })
        .expect(200);
      await realRun(job.id);
      expect(thai.albumName).toBe('Bangkok with friends');
      expect(lib.album('Czechia 2026')).toBeDefined();
      expect(lib.album(CZ)).toBeUndefined();
    });

    it('mirror mode removes owned assets that no longer belong, never manual adds', async () => {
      const job = await createJob({ syncMode: 'mirror' });
      await realRun(job.id);
      const thai = lib.album(THAI)!;
      const owned = [...thai.members][0];
      const homePhoto = tripAssets('2026-02-02', '2026-02-02')[0];
      thai.members.add(homePhoto);
      // Moving an owned asset to the exclusion album: it no longer belongs.
      lib.album('Trips – excluded')!.members.add(owned);

      const r = await realRun(job.id);
      expect(r.removed).toBe(1);
      expect(thai.members.has(owned)).toBe(false);
      expect(thai.members.has(homePhoto)).toBe(true);
    });

    it('treat an album deleted in Immich as ignored, without recreating it', async () => {
      const job = await createJob(additive);
      await realRun(job.id);
      const [thaiGroup] = await storedGroups(job.id);
      lib.albums.delete(thaiGroup.albumId!);

      await realRun(job.id);
      expect(lib.album(THAI)).toBeUndefined();
      expect((await storedGroups(job.id))[0].status).toBe('ignored');
    });

    it('refuse to create a flood of albums on the first run without a review', async () => {
      const t = new Timeline('me');
      for (let m = 0; m < 31; m++) {
        const base = Date.UTC(2023, 0, 1) + m * 12 * 86_400_000;
        const day = (d: number) =>
          new Date(base + d * 86_400_000).toISOString().slice(0, 10);
        t.days(day(0), day(8), PLACES.berlinHome);
        t.days(day(9), day(11), PLACES.prague);
      }
      t.days('2024-01-10', '2024-03-01', PLACES.berlinHome);
      lib.assets = t.assets.map(toImmich);
      const job = await createJob(additive);
      const r = await run(job.id, false);
      expect(r.status).toBe('failed');
      expect(r.error).toMatch(/would create 31 albums/);
      expect(lib.allAlbumWrites()).toBe(0);
    });
  });

  describe('adoption of existing albums', () => {
    it('proposes a hand-made album, adopts it on apply and only adds to it', async () => {
      const thaiIds = tripAssets('2026-03-04', '2026-03-18');
      const handMade = lib.addAlbum(
        'Thailand 2026',
        thaiIds.slice(0, Math.ceil(thaiIds.length * 0.6)),
      );
      const job = await createJob();
      const dry = await run(job.id, true);
      const groups = (await http.get(`/api/runs/${dry.id}/groups`).expect(200))
        .body as {
        items: {
          key: string;
          albumId: string | null;
          summary: { adoptAlbumName?: string };
        }[];
      };
      const thai = groups.items.find((g) => g.key === 'trip:2026-03-04')!;
      expect(thai.albumId).toBe(handMade);
      expect(thai.summary.adoptAlbumName).toBe('Thailand 2026');

      const preview = await http
        .get(`/api/runs/${dry.id}/apply-preview`)
        .expect(200);
      expect(preview.body).toMatchObject({
        kind: 'groups',
        selected: 2,
        create: 1,
        adopt: 1,
      });

      await http.post(`/api/runs/${dry.id}/apply`).expect(200);
      expect(lib.album(THAI)).toBeUndefined();
      expect(lib.members('Thailand 2026')).toEqual(
        expect.arrayContaining(thaiIds),
      );
      const stored = await storedGroups(job.id);
      expect(stored[0]).toMatchObject({
        albumId: handMade,
        adopted: true,
        nameLocked: true,
      });
    });

    it('can create a new album instead', async () => {
      const thaiIds = tripAssets('2026-03-04', '2026-03-18');
      lib.addAlbum('Thailand 2026', thaiIds.slice(0, 20));
      const job = await createJob();
      const dry = await run(job.id, true);
      await http
        .patch(`/api/runs/${dry.id}/groups`)
        .send({ adopt: false, keys: ['trip:2026-03-04'] })
        .expect(200);
      await http.post(`/api/runs/${dry.id}/apply`).expect(200);
      expect(lib.members(THAI)).toEqual(expect.arrayContaining(thaiIds));
      expect(lib.members('Thailand 2026')).toHaveLength(20);
    });

    it('never adopts albums of other jobs or unrelated albums', async () => {
      lib.addAlbum(
        'All of 2026',
        assets.map((a) => a.id),
      );
      const job = await createJob();
      const dry = await run(job.id, true);
      const groups = (await http.get(`/api/runs/${dry.id}/groups`).expect(200))
        .body as { items: { albumId: string | null }[] };
      expect(groups.items.every((g) => g.albumId === null)).toBe(true);
    });
  });

  describe('apply of a reviewed dry run', () => {
    it('creates the ticked trips, remembers unticked ones as ignored, once', async () => {
      const job = await createJob();
      const dry = await run(job.id, true);
      await http
        .patch(`/api/runs/${dry.id}/groups`)
        .send({ selected: false, keys: ['trip:2026-05-01'] })
        .expect(200);

      const res = await http.post(`/api/runs/${dry.id}/apply`).expect(200);
      expect(res.body).toMatchObject({
        kind: 'groups',
        result: { created: 1, ignored: 1 },
      });
      expect(lib.album(THAI)).toBeDefined();
      expect(lib.album(CZ)).toBeUndefined();
      expect((await storedGroups(job.id)).map((g) => g.status)).toEqual([
        'active',
        'ignored',
      ]);

      await http.post(`/api/runs/${dry.id}/apply`).expect(409);

      // Later real runs keep the unticked trip out.
      await http.patch(`/api/jobs/${job.id}`).send(additive).expect(200);
      await realRun(job.id);
      expect(lib.album(CZ)).toBeUndefined();
    });

    it('refuses a dry run that is older than the last sync', async () => {
      const job = await createJob();
      const dry = await run(job.id, true);
      await http.patch(`/api/jobs/${job.id}`).send(additive).expect(200);
      await realRun(job.id);
      await http.post(`/api/runs/${dry.id}/apply`).expect(409);
    });
  });
});
