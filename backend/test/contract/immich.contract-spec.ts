import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.schema.js';
import {
  AssetTypeEnum,
  AssetVisibility,
  ImmichClient,
  type AssetResponseDto,
} from '../../src/immich/immich.client.js';
import { RunQueue } from '../../src/runner/run-queue.js';

/**
 * Contract tests against a real throwaway Immich v3 seeded with the spike
 * fixtures (tools/immich-spike: `npm run fixtures && npm run seed`):
 * 5 timeline images (2 screenshot-named PNGs, 2 iPhone-sized PNGs, 1 camera JPEG)
 * and 1 archived PNG.
 */
const url = process.env.IMMICH_CONTRACT_URL;
const key = process.env.IMMICH_CONTRACT_KEY;
const suffix = `${Date.now()}`;

describe.skipIf(!url || !key)('Immich v3 contract', () => {
  let immich: ImmichClient;
  let byName: Map<string, AssetResponseDto>;

  beforeAll(async () => {
    immich = new ImmichClient({
      baseUrl: url!,
      apiKey: key!,
      retryBaseMs: 200,
    });
    // Uploads are processed asynchronously: wait until metadata (dimensions) is extracted.
    for (let i = 0; i < 60; i++) {
      const page = await immich.searchMetadataPage({
        visibility: [AssetVisibility.Timeline, AssetVisibility.Archive],
        withExif: true,
      });
      byName = new Map(page.items.map((a) => [a.originalFileName, a]));
      if (
        page.items.length >= 6 &&
        page.items.every((a) => a.width && a.exifInfo)
      )
        return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('Seeded assets did not get metadata in time');
  });

  describe('ImmichClient', () => {
    it('accepts the server version', async () => {
      expect((await immich.assertCompatible()).major).toBe(3);
    });

    it('pages with cursors and filters by type and visibility', async () => {
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await immich.searchMetadataPage({
          type: AssetTypeEnum.Image,
          visibility: [AssetVisibility.Timeline],
          size: 2,
          cursor,
        });
        names.push(...page.items.map((a) => a.originalFileName));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(names.sort()).toEqual([
        'Bildschirmfoto 2026-01-01 um 12.00.00.png',
        'DSC_0001.JPG',
        'IMG_0001.PNG',
        'IMG_0002.PNG',
        'Screenshot_20260101-120000.png',
      ]);
    });

    it('creates albums, adds and removes with per-id results', async () => {
      const name = `contract-client-${suffix}`;
      expect(await immich.findAlbum(name)).toBeNull();
      const album = await immich.findOrCreateAlbum(name);
      expect(album.created).toBe(true);
      expect((await immich.findOrCreateAlbum(name)).id).toBe(album.id);

      const ids = [
        byName.get('IMG_0001.PNG')!.id,
        byName.get('DSC_0001.JPG')!.id,
      ];
      const bogus = '00000000-0000-4000-8000-000000000000';
      expect(await immich.addToAlbum(album.id, [...ids, bogus])).toEqual({
        succeeded: ids,
        unchanged: [],
        failed: [{ id: bogus, error: 'no_permission' }],
      });
      expect(await immich.addToAlbum(album.id, ids)).toMatchObject({
        succeeded: [],
        unchanged: ids,
      });
      expect((await immich.listAlbumMemberIds(album.id)).sort()).toEqual(
        [...ids].sort(),
      );
      expect(
        await immich.removeFromAlbum(album.id, [ids[0], bogus]),
      ).toMatchObject({
        succeeded: [ids[0]],
        unchanged: [bogus],
      });
      expect(await immich.listAlbumMemberIds(album.id)).toEqual([ids[1]]);
    });

    it('reads the start of an original with Range', async () => {
      const head = await immich.readOriginalHead(
        byName.get('IMG_0001.PNG')!.id,
      );
      expect(head.partial).toBe(true);
      expect(head.data.byteLength).toBe(65536);
    });
  });

  describe('app: album sync end to end', () => {
    let app: INestApplication<App>;
    let http: ReturnType<typeof request>;
    let dataDir: string;

    beforeAll(async () => {
      dataDir = mkdtempSync(join(tmpdir(), 'iaj-contract-'));
      const config = loadConfig({
        IMMICH_URL: url,
        IMMICH_API_KEY: key,
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
      rmSync(dataDir, { recursive: true, force: true });
    });

    const run = async (jobId: string, body: Record<string, unknown> = {}) => {
      const { body: started } = await http
        .post(`/api/jobs/${jobId}/runs`)
        .send(body)
        .expect(202);
      await app.get(RunQueue).idle();
      return (await http.get(`/api/runs/${started.id}`).expect(200))
        .body as Record<string, unknown> & { id: string };
    };
    const members = async (albumName: string) => {
      const album = await immich.findAlbum(albumName);
      const ids = album ? await immich.listAlbumMemberIds(album.id) : [];
      const names = new Map(
        [...byName.values()].map((a) => [a.id, a.originalFileName]),
      );
      return ids
        .map((id) => names.get(id))
        .sort((a, b) => String(a).localeCompare(String(b)));
    };

    it('additive run fills the album; rerun adds nothing; exclusion keeps an asset out; mirror removes', async () => {
      const album = `Screenshots ${suffix}`;
      const { body: job } = await http
        .post('/api/jobs')
        .send({
          name: 'Contract',
          typeId: 'screenshot-detector',
          targetAlbumName: album,
          syncMode: 'additive',
        })
        .expect(201);

      const first = await run(job.id);
      expect(first).toMatchObject({
        status: 'succeeded',
        scanned: 5,
        matched: 4,
        added: 4,
        removed: 0,
      });
      expect(await members(album)).toEqual([
        'Bildschirmfoto 2026-01-01 um 12.00.00.png',
        'IMG_0001.PNG',
        'IMG_0002.PNG',
        'Screenshot_20260101-120000.png',
      ]);

      expect(await run(job.id)).toMatchObject({
        status: 'succeeded',
        matched: 4,
        added: 0,
      });

      // Move IMG_0002 to the exclusion album by hand.
      const target = (await immich.findAlbum(album))!;
      const exclusion = (await immich.findAlbum(`${album} – excluded`))!;
      const moved = byName.get('IMG_0002.PNG')!.id;
      await immich.removeFromAlbum(target.id, [moved]);
      await immich.addToAlbum(exclusion.id, [moved]);
      expect(await run(job.id)).toMatchObject({ matched: 3, added: 0 });
      expect(await members(album)).not.toContain('IMG_0002.PNG');

      // Mirror + stricter threshold: IMG_0001 (0.6) no longer matches and is removed.
      await http
        .patch(`/api/jobs/${job.id}`)
        .send({ syncMode: 'mirror', params: { threshold: 0.9 } })
        .expect(200);
      expect(await run(job.id)).toMatchObject({
        status: 'succeeded',
        matched: 2,
        removed: 1,
      });
      expect(await members(album)).toEqual([
        'Bildschirmfoto 2026-01-01 um 12.00.00.png',
        'Screenshot_20260101-120000.png',
      ]);
    });

    it('dry run + apply adds only the selected candidates', async () => {
      const album = `Applied ${suffix}`;
      const { body: job } = await http
        .post('/api/jobs')
        .send({
          name: 'Contract apply',
          typeId: 'screenshot-detector',
          targetAlbumName: album,
        })
        .expect(201);
      const dry = await run(job.id);
      expect(dry).toMatchObject({ dryRun: true, matched: 4 });
      expect(await immich.findAlbum(album)).toBeNull(); // dry runs change nothing

      const lowest = (
        await http
          .get(`/api/runs/${dry.id}/candidates?sort=name&limit=1`)
          .expect(200)
      ).body.items[0];
      await http
        .patch(`/api/runs/${dry.id}/candidates`)
        .send({ selected: false, assetIds: [lowest.assetId] })
        .expect(200);
      expect(
        (await http.get(`/api/runs/${dry.id}/apply-preview`).expect(200)).body,
      ).toMatchObject({
        albumExists: false,
        selected: 3,
        toAdd: 3,
      });
      const applied = (await http.post(`/api/runs/${dry.id}/apply`).expect(200))
        .body;
      expect(applied).toMatchObject({ albumCreated: true, added: 3 });
      expect(await members(album)).toHaveLength(3);
      expect(await members(album)).not.toContain(lowest.originalFileName);
    });
  });
});
