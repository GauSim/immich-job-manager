import type { LoggerService } from '@nestjs/common';
import {
  FakeImmichServer,
  fakeAsset,
  searchResponse,
} from '../../test/support/fake-immich-server.js';
import {
  ALBUM_CHUNK_SIZE,
  AssetTypeEnum,
  AssetVisibility,
  ImmichClient,
} from './immich.client.js';
import {
  ImmichApiError,
  ImmichIncompatibleError,
  ImmichSmartSearchUnavailableError,
  ImmichUnreachableError,
} from './immich.errors.js';

const silentLogger = (): LoggerService & { warnings: string[] } => {
  const warnings: string[] = [];
  return {
    warnings,
    log: () => {},
    error: () => {},
    warn: (m: unknown) => void warnings.push(String(m)),
  };
};

describe('ImmichClient', () => {
  let server: FakeImmichServer;
  let logger: ReturnType<typeof silentLogger>;
  let client: ImmichClient;

  const makeClient = (
    extra: Partial<ConstructorParameters<typeof ImmichClient>[0]> = {},
  ) =>
    new ImmichClient({
      baseUrl: server.url,
      apiKey: 'secret-key',
      retryBaseMs: 1,
      logger,
      ...extra,
    });

  beforeEach(async () => {
    server = await new FakeImmichServer().start();
    logger = silentLogger();
    client = makeClient();
  });

  afterEach(() => server.stop());

  describe('version check', () => {
    it('accepts v3.x and sends the API key', async () => {
      server.on('GET /server/version', () => ({
        json: { major: 3, minor: 3, patch: 5, prerelease: null },
      }));
      await expect(client.assertCompatible()).resolves.toEqual({
        major: 3,
        minor: 3,
        patch: 5,
        version: 'v3.3.5',
      });
      expect(server.requests[0].headers['x-api-key']).toBe('secret-key');
    });

    it.each([2, 4])('rejects major %i', async (major) => {
      server.on('GET /server/version', () => ({
        json: { major, minor: 0, patch: 0 },
      }));
      await expect(client.assertCompatible()).rejects.toBeInstanceOf(
        ImmichIncompatibleError,
      );
    });
  });

  describe('retries', () => {
    it('retries 5xx and 429 and then succeeds', async () => {
      server.sequence('GET /server/version', [
        { status: 503, json: { message: 'busy' } },
        {
          status: 429,
          json: { message: 'slow down' },
          headers: { 'retry-after': '0' },
        },
        { json: { major: 3, minor: 1, patch: 0 } },
      ]);
      await expect(client.getVersion()).resolves.toMatchObject({ major: 3 });
      expect(server.requestsTo('GET /server/version')).toHaveLength(3);
      expect(logger.warnings[0]).toMatch(
        /HTTP 503 \(correlation id corr-1\), retry 1\/3/,
      );
    });

    it('gives up after 3 retries with the correlation id of the last response', async () => {
      server.on('POST /search/metadata', () => ({
        status: 500,
        json: { message: 'boom' },
      }));
      const error = await client
        .searchMetadataPage({})
        .catch((e: unknown) => e);
      expect(server.requestsTo('POST /search/metadata')).toHaveLength(4);
      expect(error).toBeInstanceOf(ImmichApiError);
      expect(error).toMatchObject({
        status: 500,
        correlationId: 'corr-4',
        operation: 'searchMetadata',
      });
      expect((error as Error).message).toContain('correlation id corr-4');
    });

    it('does not retry 4xx and surfaces validation details', async () => {
      server.on('POST /search/metadata', () => ({
        status: 400,
        json: {
          message: 'Validation failed',
          errors: [{ path: ['size'], message: 'Too small' }],
        },
      }));
      const error = await client
        .searchMetadataPage({ size: 0 })
        .catch((e: unknown) => e);
      expect(server.requests).toHaveLength(1);
      expect((error as Error).message).toContain(
        'Validation failed (size: Too small)',
      );
    });

    it('can disable retries', async () => {
      server.on('GET /server/version', () => ({ status: 502 }));
      await expect(client.getVersion({ retry: false })).rejects.toMatchObject({
        status: 502,
      });
      expect(server.requests).toHaveLength(1);
    });

    it('retries network errors and reports unreachable', async () => {
      await server.stop();
      await expect(client.getVersion()).rejects.toBeInstanceOf(
        ImmichUnreachableError,
      );
      expect(logger.warnings.filter((w) => w.includes('retry'))).toHaveLength(
        3,
      );
    });

    it('stops retrying when aborted', async () => {
      server.on('GET /server/version', () => ({ status: 503 }));
      const slow = makeClient({ retryBaseMs: 10_000 });
      const controller = new AbortController();
      const pending = slow.getVersion({ signal: controller.signal });
      setTimeout(() => controller.abort(new Error('cancelled')), 50);
      await expect(pending).rejects.toThrow('cancelled');
      expect(server.requests).toHaveLength(1);
    });
  });

  describe('concurrency', () => {
    it('limits API calls to the configured concurrency', async () => {
      server.on('GET /server/version', async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { json: { major: 3, minor: 0, patch: 0 } };
      });
      await Promise.all(Array.from({ length: 8 }, () => client.getVersion()));
      expect(server.maxInFlight).toBe(2);
    });
  });

  describe('searchMetadataPage', () => {
    it('uses the filter DSL with cursor pagination', async () => {
      server.on('POST /search/metadata', () => ({
        json: searchResponse([fakeAsset('a')], 'next-1'),
      }));
      const page = await client.searchMetadataPage({
        type: AssetTypeEnum.Image,
        visibility: [AssetVisibility.Timeline],
        updatedAfter: new Date('2026-01-01T00:00:00Z'),
        withExif: true,
        cursor: 'cur-0',
      });
      expect(page).toEqual({
        items: [expect.objectContaining({ id: 'a' })],
        nextCursor: 'next-1',
      });
      expect(server.requests[0].body).toEqual({
        filter: {
          type: { eq: 'IMAGE' },
          visibility: { in: ['timeline'] },
          updatedAt: { gt: '2026-01-01T00:00:00.000Z' },
        },
        orderBy: { field: 'fileCreatedAt', direction: 'asc' },
        withExif: true,
        size: 1000,
        cursor: 'cur-0',
      });
    });

    it('lists album members across pages', async () => {
      server.on('POST /search/metadata', (req) => {
        const body = req.body as { cursor?: string; filter: unknown };
        expect(body.filter).toEqual({ albumIds: { any: ['album-1'] } });
        return body.cursor
          ? { json: searchResponse([fakeAsset('c')]) }
          : { json: searchResponse([fakeAsset('a'), fakeAsset('b')], 'p2') };
      });
      await expect(client.listAlbumMemberIds('album-1')).resolves.toEqual([
        'a',
        'b',
        'c',
      ]);
    });
  });

  describe('searchSmart', () => {
    it('pages until the limit and returns ids in rank order', async () => {
      server.on('POST /search/smart', (req) => {
        const { page } = req.body as { page: number };
        const items = [fakeAsset(`p${page}-1`), fakeAsset(`p${page}-2`)];
        return {
          json: {
            albums: {},
            assets: { items, nextPage: page < 3 ? String(page + 1) : null },
          },
        };
      });
      await expect(
        client.searchSmart({ query: 'phone screen', limit: 5 }),
      ).resolves.toEqual(['p1-1', 'p1-2', 'p2-1', 'p2-2', 'p3-1']);
    });

    it('maps a 500 to ImmichSmartSearchUnavailableError', async () => {
      server.on('POST /search/smart', () => ({
        status: 500,
        json: { message: 'Failed to search smart' },
      }));
      await expect(
        client.searchSmart({ query: 'x', limit: 10 }),
      ).rejects.toBeInstanceOf(ImmichSmartSearchUnavailableError);
    });
  });

  describe('albums', () => {
    it('finds an existing owned album by exact name', async () => {
      server.on('GET /albums', () => ({
        json: [
          { id: '1', albumName: 'Screenshots old' },
          { id: '2', albumName: 'Screenshots' },
        ],
      }));
      await expect(client.findOrCreateAlbum('Screenshots')).resolves.toEqual({
        id: '2',
        name: 'Screenshots',
        created: false,
      });
      expect(server.requestsTo('POST /albums')).toHaveLength(0);
    });

    it('creates the album when missing', async () => {
      server.on('GET /albums', () => ({ json: [] }));
      server.on('POST /albums', () => ({
        status: 201,
        json: { id: 'new', albumName: 'Screenshots' },
      }));
      await expect(
        client.findOrCreateAlbum('Screenshots', { description: 'auto' }),
      ).resolves.toEqual({
        id: 'new',
        name: 'Screenshots',
        created: true,
      });
      expect(server.requestsTo('POST /albums')[0].body).toEqual({
        albumName: 'Screenshots',
        description: 'auto',
      });
    });

    it('adds in chunks of 500, de-duplicates ids and classifies per-id results', async () => {
      const ids = Array.from({ length: 1201 }, (_, i) => `id-${i}`);
      ids.push('id-0'); // duplicate input id
      server.on('PUT /albums/album-1/assets', (req) => {
        const chunk = (req.body as { ids: string[] }).ids;
        return {
          json: chunk.map((id) =>
            id === 'id-1'
              ? { id, success: false, error: 'duplicate' }
              : id === 'id-2'
                ? { id, success: false, error: 'no_permission' }
                : { id, success: true },
          ),
        };
      });
      const result = await client.addToAlbum('album-1', ids);
      const calls = server
        .requestsTo('PUT /albums/album-1/assets')
        .map((r) => (r.body as { ids: string[] }).ids.length);
      expect(calls).toEqual([ALBUM_CHUNK_SIZE, ALBUM_CHUNK_SIZE, 201]);
      expect(result.succeeded).toHaveLength(1199);
      expect(result.unchanged).toEqual(['id-1']);
      expect(result.failed).toEqual([{ id: 'id-2', error: 'no_permission' }]);
      expect(logger.warnings.at(-1)).toMatch(/1 id\(s\) refused/);
    });

    it('removes in chunks and treats not_found as unchanged', async () => {
      server.on('DELETE /albums/album-1/assets', (req) => ({
        json: (req.body as { ids: string[] }).ids.map((id) =>
          id === 'gone'
            ? { id, success: false, error: 'not_found' }
            : { id, success: true },
        ),
      }));
      await expect(
        client.removeFromAlbum('album-1', ['a', 'gone']),
      ).resolves.toEqual({
        succeeded: ['a'],
        unchanged: ['gone'],
        failed: [],
      });
    });

    it('makes no calls for an empty id list', async () => {
      await expect(client.addToAlbum('album-1', [])).resolves.toEqual({
        succeeded: [],
        unchanged: [],
        failed: [],
      });
      expect(server.requests).toHaveLength(0);
    });
  });

  describe('readOriginalHead', () => {
    const file = Buffer.alloc(200_000, 7);

    it('requests a byte range and returns the partial content', async () => {
      server.on('GET /assets/a1/original', (req, res) => {
        expect(req.headers.range).toBe('bytes=0-65535');
        res.writeHead(206, {
          'content-range': `bytes 0-65535/${file.length}`,
          'content-type': 'image/png',
        });
        res.end(file.subarray(0, 65536));
      });
      const head = await client.readOriginalHead('a1');
      expect(head.partial).toBe(true);
      expect(head.data.byteLength).toBe(65536);
      expect(head.totalSize).toBe(file.length);
    });

    it('truncates when the server ignores Range', async () => {
      server.on('GET /assets/a1/original', (_req, res) => {
        res.writeHead(200, { 'content-length': String(file.length) });
        res.end(file);
      });
      const head = await client.readOriginalHead('a1', { bytes: 1000 });
      expect(head).toMatchObject({ partial: false, totalSize: file.length });
      expect(head.data.byteLength).toBe(1000);
    });

    it('limits concurrent file reads separately from API calls', async () => {
      const limited = makeClient({ fileConcurrency: 3 });
      server.on('GET /assets/a1/original', async (_req, res) => {
        await new Promise((r) => setTimeout(r, 20));
        res.writeHead(206);
        res.end(Buffer.alloc(10));
      });
      await Promise.all(
        Array.from({ length: 9 }, () => limited.readOriginalHead('a1')),
      );
      expect(server.maxInFlight).toBe(3);
    });

    it('throws ImmichApiError on 403', async () => {
      server.on('GET /assets/a1/original', () => ({
        status: 403,
        json: { message: 'Missing required permission: asset.download' },
      }));
      await expect(client.readOriginalHead('a1')).rejects.toThrow(
        /HTTP 403: Missing required permission: asset.download/,
      );
    });
  });

  describe('getThumbnail', () => {
    it('streams the thumbnail with its content type', async () => {
      server.on('GET /assets/a1/thumbnail', (_req, res) => {
        res.writeHead(200, {
          'content-type': 'image/webp',
          'content-length': '3',
        });
        res.end(Buffer.from([1, 2, 3]));
      });
      const thumb = await client.getThumbnail('a1');
      expect(thumb.contentType).toBe('image/webp');
      expect(thumb.contentLength).toBe(3);
      expect(
        new Uint8Array(await new Response(thumb.body).arrayBuffer()),
      ).toEqual(new Uint8Array([1, 2, 3]));
    });
  });
});
