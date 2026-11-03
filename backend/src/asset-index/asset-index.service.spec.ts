import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import {
  FakeImmichServer,
  serveLibrary,
} from '../../test/support/fake-immich-server.js';
import { immichAsset } from '../../test/support/immich-asset.js';
import { ImmichClient } from '../immich/immich.client.js';
import {
  buildDataSourceOptions,
  databasePath,
} from '../persistence/data-source.options.js';
import { SqliteService } from '../persistence/sqlite.service.js';
import { AssetIndexService } from './asset-index.service.js';

const silent = { log: () => {}, error: () => {}, warn: () => {} };

/** `n` own phone photos one hour apart, starting 2026-03-01 00:00 UTC. */
function library(n: number, prefix = 'a') {
  return Array.from({ length: n }, (_, i) => {
    const t = new Date(Date.UTC(2026, 2, 1, i)).toISOString();
    return immichAsset(`${prefix}${i}`, {
      fileCreatedAt: t,
      localDateTime: t,
    }) as unknown as Record<string, unknown>;
  });
}

describe('AssetIndexService (SQLite + fake Immich)', () => {
  let dir: string;
  let ds: DataSource;
  let server: FakeImmichServer;
  let index: AssetIndexService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iaj-index-'));
    ds = await new DataSource(
      buildDataSourceOptions(databasePath(dir)),
    ).initialize();
    await ds.runMigrations();
    server = await new FakeImmichServer().start();
    const immich = new ImmichClient({
      baseUrl: server.url,
      apiKey: 'k',
      retryBaseMs: 1,
      logger: silent,
    });
    index = new AssetIndexService(immich, new SqliteService(ds));
  });

  afterEach(async () => {
    await server.stop();
    await ds.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  const searches = () => server.requestsTo('POST /search/metadata');

  it('indexes images and videos of the timeline and archive, with EXIF', async () => {
    serveLibrary(server, [
      ...library(3),
      immichAsset('hidden', {
        visibility: 'hidden',
      } as never) as unknown as Record<string, unknown>,
    ]);
    const totals = await index.refreshAll();
    expect(totals).toEqual({ scanned: 4, indexed: 3, removed: 0 });
    expect(index.count()).toBe(3);
    expect(searches()[0].body).toMatchObject({
      filter: {
        type: { in: ['IMAGE', 'VIDEO'] },
        visibility: { in: ['timeline', 'archive'] },
      },
      withExif: true,
      size: 1000,
    });
  });

  it('round-trips every field through SQLite', async () => {
    serveLibrary(server, [
      immichAsset(
        'x',
        {
          ownerId: 'partner',
          fileCreatedAt: '2026-03-04T00:20:00.123Z',
          localDateTime: '2026-03-04T07:20:00.123Z',
        },
        { make: null, model: null, description: 'Screenshot' },
      ) as unknown as Record<string, unknown>,
    ]);
    await index.refreshAll();
    const [row] = index.read({ ownerId: 'me', includePartners: true }).all();
    expect(row).toEqual({
      id: 'x',
      ownerId: 'partner',
      type: 'IMAGE',
      visibility: 'timeline',
      takenAt: Date.parse('2026-03-04T00:20:00.123Z'),
      localDateTime: '2026-03-04T07:20:00.123',
      timeZone: 'Asia/Bangkok',
      latitude: 13.75,
      longitude: 100.5,
      city: 'Bangkok',
      state: 'Bangkok',
      country: 'Thailand',
      hasCamera: false,
      isScreenshot: true,
      fileName: 'x.heic',
    });
  });

  it('pages lazily and is idempotent', async () => {
    serveLibrary(server, library(2500));
    await index.refreshAll();
    expect(searches()).toHaveLength(3);
    expect(index.count()).toBe(2500);
    const again = await index.refreshAll();
    expect(again).toEqual({ scanned: 2500, indexed: 2500, removed: 0 });
    expect(index.count()).toBe(2500);
  });

  it('updates changed assets and deletes ones Immich no longer returns', async () => {
    const lib = library(3);
    serveLibrary(server, lib);
    await index.refreshAll({ startedAt: new Date('2026-11-01T00:00:00Z') });

    const moved = immichAsset(
      'a1',
      {
        fileCreatedAt: lib[1].fileCreatedAt as string,
        localDateTime: lib[1].localDateTime as string,
      },
      { country: 'Germany', city: 'Berlin' },
    ) as unknown as Record<string, unknown>;
    serveLibrary(server, [lib[0], moved]); // a2 deleted in Immich
    const totals = await index.refreshAll({
      startedAt: new Date('2026-11-02T00:00:00Z'),
    });
    expect(totals.removed).toBe(1);
    const rows = index.read({ ownerId: 'me' }).all();
    expect(rows.map((r) => r.id)).toEqual(['a0', 'a1']);
    expect(rows[1].country).toBe('Germany');
  });

  it('resumes an interrupted refresh without losing rows', async () => {
    serveLibrary(server, library(3000));
    await index.refreshAll({ startedAt: new Date('2026-11-01T00:00:00Z') });

    // Second refresh, interrupted after its first page.
    const startedAt = new Date('2026-11-02T00:00:00Z');
    let cursor: string | null = null;
    for await (const page of index.refresh({ startedAt })) {
      cursor = page.cursor;
      break;
    }
    expect(cursor).not.toBeNull();

    // Resume with the same start time, then complete.
    for await (const page of index.refresh({
      startedAt,
      resumeFrom: cursor!,
    })) {
      void page;
    }
    expect(index.completeRefresh(startedAt)).toBe(0);
    expect(index.count()).toBe(3000);
    expect(
      searches().map((r) => (r.body as { cursor?: string }).cursor),
    ).toEqual([
      undefined,
      expect.any(String),
      expect.any(String),
      undefined,
      expect.any(String),
      expect.any(String),
    ]);
  });

  it('stops between pages when aborted', async () => {
    serveLibrary(server, library(2500));
    const controller = new AbortController();
    const pages: number[] = [];
    await expect(async () => {
      for await (const page of index.refresh({
        startedAt: new Date(),
        signal: controller.signal,
      })) {
        pages.push(page.indexed);
        controller.abort();
      }
    }).rejects.toThrow();
    expect(pages).toEqual([1000]);
    expect(index.count()).toBe(1000);
  });

  it('forgets refused assets', async () => {
    serveLibrary(server, library(3));
    await index.refreshAll();
    expect(index.forget(['a0', 'a2', 'unknown'])).toBe(2);
    expect(
      index
        .read({ ownerId: 'me' })
        .all()
        .map((r) => r.id),
    ).toEqual(['a1']);
    expect(index.forget([])).toBe(0);
  });
});
