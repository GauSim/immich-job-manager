import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
  query?: URLSearchParams;
  /** Regex groups for `onMatch` routes. */
  params?: string[];
}

export interface CannedResponse {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

/** Either returns a canned response or writes to `res` itself. */
export type Handler = (
  req: RecordedRequest,
  res: ServerResponse,
) => void | CannedResponse | Promise<void | CannedResponse>;

/**
 * Minimal HTTP server standing in for Immich in tests.
 * Routes are `"METHOD /path"` (path without query string, relative to `/api`).
 * Unmatched routes answer 404. Every request is recorded.
 */
export class FakeImmichServer {
  readonly requests: RecordedRequest[] = [];
  private readonly routes = new Map<string, Handler>();
  private readonly patterns: {
    method: string;
    re: RegExp;
    handler: Handler;
  }[] = [];
  private server?: Server;
  private correlationSeq = 0;
  inFlight = 0;
  maxInFlight = 0;

  /** Base URL including `/api`. */
  url = '';

  on(route: string, handler: Handler): this {
    this.routes.set(route, handler);
    return this;
  }

  /** Route by method + regular expression on the path (after `/api`); `req.params` gets the groups. */
  onMatch(method: string, re: RegExp, handler: Handler): this {
    this.patterns.push({ method, re, handler });
    return this;
  }

  /** Recorded requests whose method and path match. */
  requestsMatching(method: string, re: RegExp): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && re.test(r.path));
  }

  /** Answers the route with the given responses in order; the last one repeats. */
  sequence(route: string, responses: CannedResponse[]): this {
    let i = 0;
    return this.on(route, () => responses[Math.min(i++, responses.length - 1)]);
  }

  requestsTo(route: string): RecordedRequest[] {
    const [method, path] = route.split(' ');
    return this.requests.filter((r) => r.method === method && r.path === path);
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}/api`;
    return this;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://x');
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: url.pathname.replace(/^\/api/, ''),
        headers: req.headers,
        body: raw ? safeJson(raw) : undefined,
        query: url.searchParams,
      };
      this.requests.push(recorded);
      res.setHeader('x-correlation-id', `corr-${++this.correlationSeq}`);
      let handler = this.routes.get(`${recorded.method} ${recorded.path}`);
      if (!handler) {
        for (const p of this.patterns) {
          const m =
            p.method === recorded.method ? p.re.exec(recorded.path) : null;
          if (m) {
            recorded.params = m.slice(1);
            handler = p.handler;
            break;
          }
        }
      }
      if (!handler) {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: 'Not found' }));
        return;
      }
      const out = await handler(recorded, res);
      if (out && !res.writableEnded) {
        res.statusCode = out.status ?? 200;
        for (const [k, v] of Object.entries(out.headers ?? {}))
          res.setHeader(k, v);
        res.setHeader('content-type', 'application/json');
        res.end(out.json === undefined ? '' : JSON.stringify(out.json));
      }
    } finally {
      this.inFlight--;
    }
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Minimal asset as returned by /search/metadata. */
export function fakeAsset(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    originalFileName: `${id}.png`,
    checksum: `sum-${id}`,
    type: 'IMAGE',
    ...extra,
  };
}

/** `/search/metadata` response body. */
export function searchResponse(
  items: unknown[],
  nextCursor: string | null = null,
) {
  return {
    albums: { total: 0, count: 0, items: [], facets: [], nextPage: null },
    assets: {
      total: items.length,
      count: items.length,
      items,
      facets: [],
      nextPage: null,
      nextCursor,
    },
  };
}

/**
 * Serves a fake library on `/search/metadata` with Immich-style opaque cursors:
 * `count` generated images, or the given assets. `hooks.beforePage(offset)` may
 * delay or return an error response.
 */
export function serveLibrary(
  server: FakeImmichServer,
  library: number | Record<string, unknown>[],
  hooks: {
    beforePage?: (
      offset: number,
    ) => Promise<CannedResponse | void> | CannedResponse | void;
  } = {},
): void {
  const assets =
    typeof library === 'number'
      ? Array.from({ length: library }, (_, i) => fakeAsset(`asset-${i}`))
      : library;
  const count = assets.length;
  // No albums yet: runs look up their target/exclusion albums (dry runs never create them).
  server.on('GET /albums', () => ({ json: [] }));
  server.on('POST /search/metadata', async (req) => {
    const body = req.body as { cursor?: string; size?: number };
    const offset = body.cursor
      ? (
          JSON.parse(Buffer.from(body.cursor, 'base64').toString()) as {
            offset: number;
          }
        ).offset
      : 0;
    const override = await hooks.beforePage?.(offset);
    if (override) return override;
    const size = body.size ?? 1000;
    const items = assets.slice(offset, offset + size);
    const next =
      offset + size < count
        ? Buffer.from(JSON.stringify({ offset: offset + size })).toString(
            'base64',
          )
        : null;
    return { json: searchResponse(items, next) };
  });
}

type FakeAsset = Record<string, unknown> & { id: string };

/**
 * A stateful fake Immich library: metadata search (incl. album members via
 * `filter.albumIds.any`), albums (list by name, create) and album asset
 * add/remove with Immich's per-id results. Tests mutate `assets` / `albums`.
 */
export class FakeImmichLibrary {
  assets: FakeAsset[];
  readonly albums = new Map<
    string,
    { albumName: string; members: Set<string> }
  >();
  private albumSeq = 0;
  /** `updatedAt` of assets that don't set one (before any test run). */
  static readonly OLD_DATE = '2026-01-01T00:00:00.000Z';
  /** Original file bytes per asset id; default: a PNG without the iOS tag. */
  originals = new Map<string, Buffer>();
  defaultOriginal: Buffer | null = null;

  constructor(
    private readonly server: FakeImmichServer,
    assets: FakeAsset[],
  ) {
    this.assets = assets;
    server.on('GET /server/version', () => ({
      json: { major: 3, minor: 3, patch: 5 },
    }));
    server.on('POST /search/metadata', (req) => this.search(req));
    server.on('GET /albums', (req) => {
      const name = req.query?.get('name');
      return {
        json: [...this.albums.entries()]
          .filter(([, a]) => !name || a.albumName.includes(name))
          .map(([id, a]) => ({
            id,
            albumName: a.albumName,
            assetCount: a.members.size,
          })),
      };
    });
    server.on('POST /albums', (req) => {
      const { albumName } = req.body as { albumName: string };
      return {
        status: 201,
        json: { id: this.addAlbum(albumName), albumName, assetCount: 0 },
      };
    });
    server.onMatch('GET', /^\/assets\/([^/]+)\/original$/, (req, res) => {
      const id = req.params![0];
      const data =
        this.originals.get(id) ??
        (this.assets.some((a) => a.id === id) ? this.defaultOriginal : null);
      if (!data) return { status: 404, json: { message: 'Not found' } };
      const range = /bytes=0-(\d+)/.exec(String(req.headers.range ?? ''));
      const end = range
        ? Math.min(Number(range[1]), data.length - 1)
        : data.length - 1;
      res.writeHead(range ? 206 : 200, {
        'content-type': 'application/octet-stream',
        'content-length': String(end + 1),
        ...(range ? { 'content-range': `bytes 0-${end}/${data.length}` } : {}),
      });
      res.end(data.subarray(0, end + 1));
    });
    server.onMatch('PUT', /^\/albums\/([^/]+)\/assets$/, (req) =>
      this.write(req, 'add'),
    );
    server.onMatch('DELETE', /^\/albums\/([^/]+)\/assets$/, (req) =>
      this.write(req, 'remove'),
    );
  }

  addAlbum(name: string, members: string[] = []): string {
    const id = `00000000-0000-4000-8000-${String(++this.albumSeq).padStart(12, '0')}`;
    this.albums.set(id, { albumName: name, members: new Set(members) });
    return id;
  }

  album(name: string) {
    return [...this.albums.values()].find((a) => a.albumName === name);
  }

  members(name: string): string[] {
    return [...(this.album(name)?.members ?? [])].sort();
  }

  /** Album write calls (PUT/DELETE /albums/:id/assets) so far. */
  writeCalls(): number {
    return (
      this.server.requestsMatching('PUT', /^\/albums\/[^/]+\/assets$/).length +
      this.server.requestsMatching('DELETE', /^\/albums\/[^/]+\/assets$/).length
    );
  }

  private search(req: RecordedRequest): CannedResponse {
    const body = req.body as {
      cursor?: string;
      size?: number;
      filter?: { albumIds?: { any?: string[] }; updatedAt?: { gt?: string } };
    };
    const albumIds = body.filter?.albumIds?.any;
    const source = albumIds
      ? this.assets
          .filter((a) =>
            albumIds.some((id) => this.albums.get(id)?.members.has(a.id)),
          )
          .concat(
            // Members unknown to the library (e.g. added by hand in tests) still count.
            albumIds.flatMap((id) =>
              [...(this.albums.get(id)?.members ?? [])]
                .filter((m) => !this.assets.some((a) => a.id === m))
                .map((m) => fakeAsset(m)),
            ),
          )
      : this.assets;
    // Incremental runs: only assets updated after `filter.updatedAt.gt` (default: an old date).
    const updatedAfter = body.filter?.updatedAt?.gt;
    const filtered = updatedAfter
      ? source.filter(
          (a) =>
            ((a.updatedAt as string | undefined) ??
              FakeImmichLibrary.OLD_DATE) > updatedAfter,
        )
      : source;
    const offset = body.cursor
      ? (
          JSON.parse(Buffer.from(body.cursor, 'base64').toString()) as {
            offset: number;
          }
        ).offset
      : 0;
    const size = body.size ?? 1000;
    const items = filtered.slice(offset, offset + size);
    const next =
      offset + size < filtered.length
        ? Buffer.from(JSON.stringify({ offset: offset + size })).toString(
            'base64',
          )
        : null;
    return { json: searchResponse(items, next) };
  }

  private write(req: RecordedRequest, op: 'add' | 'remove'): CannedResponse {
    const album = this.albums.get(req.params![0]);
    if (!album) return { status: 400, json: { message: 'Album not found' } };
    const known = new Set(this.assets.map((a) => a.id));
    const ids = (req.body as { ids: string[] }).ids;
    return {
      json: ids.map((id) => {
        if (op === 'add') {
          if (!known.has(id))
            return { id, success: false, error: 'no_permission' };
          if (album.members.has(id))
            return { id, success: false, error: 'duplicate' };
          album.members.add(id);
          return { id, success: true };
        }
        return album.members.delete(id)
          ? { id, success: true }
          : { id, success: false, error: 'not_found' };
      }),
    };
  }
}
