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
      };
      this.requests.push(recorded);
      res.setHeader('x-correlation-id', `corr-${++this.correlationSeq}`);
      const handler = this.routes.get(`${recorded.method} ${recorded.path}`);
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
