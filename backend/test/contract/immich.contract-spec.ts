import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const uploadKey = process.env.IMMICH_CONTRACT_UPLOAD_KEY;
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

      // Rerun: incremental (nothing changed since) and a full rescan both add nothing.
      expect(await run(job.id)).toMatchObject({
        status: 'succeeded',
        fullRescan: false,
        added: 0,
      });
      expect(await run(job.id, { fullRescan: true })).toMatchObject({
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
      expect(await run(job.id, { fullRescan: true })).toMatchObject({
        matched: 3,
        added: 0,
      });
      expect(await members(album)).not.toContain('IMG_0002.PNG');

      // Mirror + stricter threshold, file tag off: IMG_0001 (0.6 from metadata)
      // no longer matches and is removed.
      await http
        .patch(`/api/jobs/${job.id}`)
        .send({
          syncMode: 'mirror',
          params: { threshold: 0.9, readIosTag: false },
        })
        .expect(200);
      expect(await run(job.id, { fullRescan: true })).toMatchObject({
        status: 'succeeded',
        matched: 2,
        removed: 1,
      });
      expect(await members(album)).toEqual([
        'Bildschirmfoto 2026-01-01 um 12.00.00.png',
        'Screenshot_20260101-120000.png',
      ]);
    });

    it('reads the iOS tag from a real original and caches it', async () => {
      // IMG_0001.PNG carries EXIF UserComment "Screenshot" but no Immich description;
      // IMG_0002.PNG is the same kind of PNG without the tag.
      const { body: job } = await http
        .post('/api/jobs')
        .send({
          name: 'Contract tag',
          typeId: 'screenshot-detector',
          targetAlbumName: `Tag ${suffix}`,
          // Both iPhone-sized PNGs score 0.6 from metadata → borderline → files are read.
          params: { threshold: 0.7 },
        })
        .expect(201);
      const first = await run(job.id);
      const list = (
        await http.get(`/api/runs/${first.id}/candidates?limit=10`).expect(200)
      ).body.items as {
        originalFileName: string;
        score: number;
        reasons: string[];
      }[];
      const byFile = new Map(list.map((c) => [c.originalFileName, c]));
      expect(byFile.get('IMG_0001.PNG')).toMatchObject({
        score: 1,
        reasons: expect.arrayContaining(['ios-tag']),
      });
      expect(byFile.has('IMG_0002.PNG')).toBe(false); // read, no tag → stays below 0.7
      expect(first.filesRead).toBe(2);

      const second = await run(job.id);
      expect(second).toMatchObject({
        filesRead: 0,
        cacheHits: first.filesRead,
      });
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

    // Last: it adds an asset to the library, which would change the counts above.
    it.skipIf(!uploadKey)(
      'an incremental run picks up a newly uploaded screenshot',
      async () => {
        const album = `Incremental ${suffix}`;
        const { body: job } = await http
          .post('/api/jobs')
          .send({
            name: 'Contract incremental',
            typeId: 'screenshot-detector',
            targetAlbumName: album,
            syncMode: 'additive',
          })
          .expect(201);
        const first = await run(job.id);
        expect(first).toMatchObject({ status: 'succeeded', fullRescan: true });

        // Upload a new iOS-style screenshot (EXIF tag only) with the upload-only key.
        const name = `Screenshot_${suffix}.png`;
        const form = new FormData();
        form.append(
          'assetData',
          new Blob([
            readFileSync(
              join(import.meta.dirname, '../fixtures/files/ios-screenshot.png'),
            ),
          ]),
          name,
        );
        form.append('filename', name);
        form.append('fileCreatedAt', new Date().toISOString());
        form.append('fileModifiedAt', new Date().toISOString());
        const res = await fetch(`${url}/assets`, {
          method: 'POST',
          headers: { 'x-api-key': uploadKey! },
          body: form,
        });
        expect(res.status).toBe(201);
        const { id: uploaded } = (await res.json()) as { id: string };
        // Wait until Immich has extracted its metadata.
        await expect
          .poll(
            async () =>
              (
                await immich.searchMetadataPage({ withExif: true, size: 1000 })
              ).items.find((a) => a.id === uploaded)?.width,
            { timeout: 60_000, interval: 1000 },
          )
          .toBeTruthy();

        const second = await run(job.id);
        expect(second).toMatchObject({
          status: 'succeeded',
          fullRescan: false,
          added: 1,
        });
        expect(second.scanned as number).toBeLessThan(first.scanned as number);
        const target = (await immich.findAlbum(album))!;
        expect(await immich.listAlbumMemberIds(target.id)).toContain(uploaded);
      },
    );
  });
});
