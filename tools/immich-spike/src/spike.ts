/**
 * Phase 0 API spike: checks the Immich v3 API shapes Immich Album Jobs relies on.
 *
 *   IMMICH_URL=http://immich_server:2283/api IMMICH_API_KEY=... npm run spike
 *
 * Optional:
 *   SPIKE_ALBUM_NAME   test album to create/use (default "immich-album-jobs-spike")
 *   SPIKE_ASSET_ID     asset for the HTTP Range test (default: first PNG found)
 *
 * Side effects on the instance: creates the test album if missing, adds up to
 * 3 assets to it and removes them again. Nothing else is changed. The album is
 * left in place (deleting needs album.delete, which the app's key should not have).
 *
 * Writes a JSON report to out/spike-report.json.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import exifr from 'exifr';
import {
  init,
  getAboutInfo,
  getServerVersion,
  searchAssets,
  searchSmart,
  getAllAlbums,
  createAlbum,
  addAssetsToAlbum,
  removeAssetFromAlbum,
  AssetTypeEnum,
  AssetVisibility,
  AssetOrder,
  SearchOrderField,
  isHttpError,
  type AssetResponseDto,
  type SearchAssetResponseDto,
} from '@immich/sdk';

const baseUrl = required('IMMICH_URL');
const apiKey = required('IMMICH_API_KEY');
const albumName = process.env.SPIKE_ALBUM_NAME || 'immich-album-jobs-spike';

const report: Record<string, unknown> = { baseUrl, startedAt: new Date().toISOString() };

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return v;
}

function describeError(e: unknown) {
  if (isHttpError(e)) return { status: e.status, data: e.data };
  return { message: (e as Error).message };
}

/** Runs one check, prints a short line, stores the result in the report. */
async function check<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const result = await fn();
    report[name] = { ok: true, result };
    console.log(`✔ ${name}`);
    return result;
  } catch (e) {
    report[name] = { ok: false, error: describeError(e) };
    console.log(`✘ ${name}: ${JSON.stringify(describeError(e))}`);
    return undefined;
  }
}

function summarize(r: SearchAssetResponseDto) {
  return {
    names: r.items.map((a) => a.originalFileName),
    count: r.count,
    total: r.total,
    nextPage: r.nextPage,
    nextCursor: r.nextCursor,
  };
}

/** Which of the fields we rely on are present (non-undefined) on a search item. */
function fieldPresence(items: AssetResponseDto[]) {
  const fields: Record<string, (a: AssetResponseDto) => unknown> = {
    id: (a) => a.id,
    originalFileName: (a) => a.originalFileName,
    originalMimeType: (a) => a.originalMimeType,
    checksum: (a) => a.checksum,
    width: (a) => a.width,
    height: (a) => a.height,
    updatedAt: (a) => a.updatedAt,
    visibility: (a) => a.visibility,
    exifInfo: (a) => a.exifInfo,
    'exifInfo.make': (a) => a.exifInfo?.make,
    'exifInfo.model': (a) => a.exifInfo?.model,
    'exifInfo.lensModel': (a) => a.exifInfo?.lensModel,
    'exifInfo.exposureTime': (a) => a.exifInfo?.exposureTime,
    'exifInfo.fNumber': (a) => a.exifInfo?.fNumber,
    'exifInfo.exifImageWidth': (a) => a.exifInfo?.exifImageWidth,
    'exifInfo.exifImageHeight': (a) => a.exifInfo?.exifImageHeight,
  };
  return Object.fromEntries(
    Object.entries(fields).map(([k, get]) => [
      k,
      {
        present: items.filter((a) => get(a) !== undefined).length,
        nonNull: items.filter((a) => get(a) != null).length,
        of: items.length,
      },
    ]),
  );
}

async function main() {
  init({ baseUrl, apiKey });

  // 1. Version
  await check('server.about', async () => {
    const about = await getAboutInfo();
    return { version: about.version, major: Number(about.version.replace(/^v/, '').split('.')[0]) };
  });
  await check('server.version', () => getServerVersion());

  // 2. Metadata search, first page
  const page1 = await check('search.metadata.page1', async () => {
    const res = await searchAssets({
      metadataSearchDto: {
        type: AssetTypeEnum.Image,
        withExif: true,
        size: 1000,
        page: 1,
        visibility: AssetVisibility.Timeline,
      },
    });
    const { items, ...rest } = res.assets;
    return {
      ...rest,
      itemCount: items.length,
      presence: fieldPresence(items),
      sample: items[0],
      items,
      exifByName: Object.fromEntries(
        items.map((a) => [
          a.originalFileName,
          { mime: a.originalMimeType, w: a.width, h: a.height, exif: a.exifInfo },
        ]),
      ),
    };
  });
  const items = page1?.items ?? [];
  if (page1)
    delete (report['search.metadata.page1'] as { result: { items?: unknown } }).result.items;

  // 3. Legacy pagination (page number). Deprecated in v3.3, cannot be combined with `filter`.
  await check('search.metadata.pagination.page', async () => {
    const base = {
      type: AssetTypeEnum.Image,
      size: 2,
      visibility: AssetVisibility.Timeline,
    } as const;
    const p1 = await searchAssets({ metadataSearchDto: { ...base, page: 1 } });
    const p2 = await searchAssets({ metadataSearchDto: { ...base, page: 2 } });
    return {
      page1: summarize(p1.assets),
      page2: summarize(p2.assets),
    };
  });

  // 4. New filter DSL + cursor pagination: walk the whole library in tiny pages.
  await check('search.metadata.pagination.cursor', async () => {
    const pages: ReturnType<typeof summarize>[] = [];
    let cursor: string | undefined;
    do {
      const res = await searchAssets({
        metadataSearchDto: {
          filter: {
            type: { eq: AssetTypeEnum.Image },
            visibility: { in: [AssetVisibility.Timeline] },
          },
          orderBy: { field: SearchOrderField.FileCreatedAt, direction: AssetOrder.Asc },
          withExif: true,
          size: 2,
          cursor,
        },
      });
      pages.push(summarize(res.assets));
      cursor = res.assets.nextCursor ?? undefined;
    } while (cursor && pages.length < 50);
    const all = pages.flatMap((p) => p.names);
    return {
      pages,
      decodedCursors: pages.map(
        (p) => p.nextCursor && Buffer.from(p.nextCursor, 'base64').toString(),
      ),
      distinct: new Set(all).size,
      total: all.length,
    };
  });

  await check('search.metadata.pageWithFilter', () =>
    searchAssets({ metadataSearchDto: { filter: {}, page: 2, size: 2 } }),
  );

  // 5. updatedAfter: legacy field and filter DSL
  await check('search.metadata.updatedAfter', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const legacyFuture = await searchAssets({
      metadataSearchDto: { updatedAfter: tomorrow, size: 100 },
    });
    const legacyPast = await searchAssets({
      metadataSearchDto: { updatedAfter: '2000-01-01T00:00:00.000Z', size: 100 },
    });
    const filterFuture = await searchAssets({
      metadataSearchDto: { filter: { updatedAt: { gt: tomorrow } }, size: 100 },
    });
    const filterPast = await searchAssets({
      metadataSearchDto: { filter: { updatedAt: { gt: '2000-01-01T00:00:00.000Z' } }, size: 100 },
    });
    return {
      legacyFuture: legacyFuture.assets.items.length,
      legacyPast: legacyPast.assets.items.length,
      filterFuture: filterFuture.assets.items.length,
      filterPast: filterPast.assets.items.length,
    };
  });

  // 6. Visibility when omitted vs explicit (seed archives wallpaper.png)
  await check('search.metadata.visibility', async () => {
    const names = async (dto: Parameters<typeof searchAssets>[0]['metadataSearchDto']) =>
      (await searchAssets({ metadataSearchDto: { size: 1000, ...dto } })).assets.items
        .map((a) => `${a.originalFileName} [${a.visibility}]`)
        .sort();
    return {
      legacyOmitted: await names({}),
      legacyTimeline: await names({ visibility: AssetVisibility.Timeline }),
      legacyArchive: await names({ visibility: AssetVisibility.Archive }),
      filterOmitted: await names({ filter: {} }),
      filterTimelineArchive: await names({
        filter: { visibility: { in: [AssetVisibility.Timeline, AssetVisibility.Archive] } },
      }),
    };
  });

  // 6b. Is exifInfo returned without withExif?
  await check('search.metadata.withoutExif', async () => {
    const res = await searchAssets({ metadataSearchDto: { filter: {}, size: 1 } });
    return { hasExifInfo: res.assets.items[0]?.exifInfo !== undefined };
  });

  // 7. Smart search (needs Immich ML; failure is informative, not fatal)
  await check('search.smart', async () => {
    const res = await searchSmart({
      smartSearchDto: { query: 'screenshot of a phone screen', size: 5 },
    });
    return { count: res.assets.items.length, nextPage: res.assets.nextPage };
  });

  // 8. Albums: find or create, add, duplicate add, bogus id, members via search, remove
  const album = await check('albums.findOrCreate', async () => {
    const all = await getAllAlbums({});
    const existing = all.find((a) => a.albumName === albumName);
    const a =
      existing ??
      (await createAlbum({
        createAlbumDto: { albumName, description: 'Immich Album Jobs API spike' },
      }));
    return {
      id: a.id,
      created: !existing,
      keys: Object.keys(a).sort(),
      hasAssetsField: 'assets' in a,
      assetCount: a.assetCount,
    };
  });
  const testIds = items.slice(0, 3).map((a) => a.id);
  if (album && testIds.length) {
    const bogus = '00000000-0000-4000-8000-000000000000';
    await check('albums.addAssets', () =>
      addAssetsToAlbum({ id: album.id, bulkIdsDto: { ids: [...testIds, bogus] } }),
    );
    await check('albums.addAssets.duplicate', () =>
      addAssetsToAlbum({ id: album.id, bulkIdsDto: { ids: testIds } }),
    );
    await check('albums.members.viaSearch', async () => {
      const res = await searchAssets({ metadataSearchDto: { albumIds: [album.id], size: 1000 } });
      return { ids: res.assets.items.map((a) => a.id), expected: testIds };
    });
    await check('albums.removeAssets', () =>
      removeAssetFromAlbum({ id: album.id, bulkIdsDto: { ids: [...testIds, bogus] } }),
    );
  }

  // 9. HTTP Range on originals
  const rangeAsset =
    process.env.SPIKE_ASSET_ID ||
    items.find((a) => /^IMG_\d+\.PNG$/i.test(a.originalFileName))?.id ??
    items.find((a) => a.originalMimeType === 'image/png')?.id ??
    items[0]?.id;
  if (rangeAsset) {
    await check('assets.original.range', async () => {
      const res = await fetch(`${baseUrl}/assets/${rangeAsset}/original`, {
        headers: { 'x-api-key': apiKey, Range: 'bytes=0-65535' },
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      const tags = await exifr
        .parse(buf, { pick: ['UserComment', 'Make', 'Model'] })
        .catch((e: Error) => ({ parseError: e.message }));
      return {
        assetId: rangeAsset,
        status: res.status,
        acceptRanges: res.headers.get('accept-ranges'),
        contentRange: res.headers.get('content-range'),
        contentLength: res.headers.get('content-length'),
        contentType: res.headers.get('content-type'),
        bytesReceived: buf.byteLength,
        userComment: decodeUserComment(tags?.userComment) ?? null,
        tagsFound: tags ? Object.keys(tags) : [],
      };
    });
  }

  // 10. Correlation id header on an error response
  await check('errors.correlationId', async () => {
    const res = await fetch(`${baseUrl}/search/metadata`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ size: -1 }),
    });
    return {
      status: res.status,
      correlationId: res.headers.get('x-correlation-id'),
      body: await res.json(),
    };
  });

  report.finishedAt = new Date().toISOString();
  await mkdir('out', { recursive: true });
  await writeFile('out/spike-report.json', JSON.stringify(report, null, 2));
  console.log('\nreport written to out/spike-report.json');
}

/** EXIF UserComment = 8-byte charset id ("ASCII\0\0\0", "UNICODE\0", ...) + payload. */
function decodeUserComment(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  const bytes =
    v instanceof Uint8Array ? v : Uint8Array.from(Object.values(v as Record<string, number>));
  const charset = new TextDecoder('latin1').decode(bytes.slice(0, 8)).replace(/\0+$/, '');
  const body = bytes.slice(8);
  const text =
    charset === 'UNICODE' ? new TextDecoder('utf-16').decode(body) : new TextDecoder().decode(body);
  return text.replace(/\0+$/, '').trim();
}

await main();
