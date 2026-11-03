import { Logger, type LoggerService } from '@nestjs/common';
import {
  addAssetsToAlbum,
  AssetOrder,
  AssetTypeEnum,
  AssetVisibility,
  createAlbum,
  getAllAlbums,
  getMyUser,
  updateAlbumInfo,
  getServerVersion,
  isHttpError,
  removeAssetFromAlbum,
  searchAssets,
  searchSmart,
  SearchOrderField,
  type AssetResponseDto,
  type BulkIdResponseDto,
  type MetadataSearchDto,
  type SearchFilter,
} from '@immich/sdk';
import pLimit, { type LimitFunction } from 'p-limit';
import {
  ImmichApiError,
  ImmichError,
  ImmichIncompatibleError,
  ImmichSmartSearchUnavailableError,
  ImmichUnreachableError,
} from './immich.errors.js';

export { AssetTypeEnum, AssetVisibility, type AssetResponseDto };

/** Immich major version this app supports. */
export const SUPPORTED_MAJOR = 3;
/** `POST /search/metadata` page size. */
export const SEARCH_PAGE_SIZE = 1000;
/** Max ids per album add/remove call. */
export const ALBUM_CHUNK_SIZE = 500;
/** Bytes read from the start of an original for EXIF tags. */
export const ORIGINAL_HEAD_BYTES = 64 * 1024;

export interface ImmichClientOptions {
  /** API base URL including `/api`. */
  baseUrl: string;
  apiKey: string;
  /** Concurrent metadata/album requests (default 2). */
  apiConcurrency?: number;
  /** Concurrent original-file reads (default 4). */
  fileConcurrency?: number;
  /** Concurrent thumbnail requests for the UI proxy (default 6). */
  thumbnailConcurrency?: number;
  /** Retries after the first attempt on 429/5xx/network errors (default 3). */
  retries?: number;
  /** First backoff delay; doubles per attempt, with jitter (default 500 ms). */
  retryBaseMs?: number;
  /** Upper bound for a single backoff delay, incl. `Retry-After` (default 30 s). */
  maxRetryDelayMs?: number;
  /** Replaceable for tests. */
  fetch?: typeof fetch;
  logger?: LoggerService;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Disable retries (e.g. for health checks). Default true. */
  retry?: boolean;
  /** Per-call timeout in ms. */
  timeoutMs?: number;
}

export interface ServerVersion {
  major: number;
  minor: number;
  patch: number;
  /** e.g. `v3.3.5` */
  version: string;
}

export interface MetadataPageQuery {
  /** Asset type, e.g. `IMAGE`. Omit for all types. */
  type?: AssetTypeEnum;
  /** Several asset types (e.g. images and videos); ignored when `type` is set. */
  types?: AssetTypeEnum[];
  /**
   * Visibilities to include. Omit to use Immich's default (timeline + archive).
   * Jobs should always set this explicitly.
   */
  visibility?: AssetVisibility[];
  /** Only assets updated strictly after this time (incremental runs). */
  updatedAfter?: Date;
  /** Only members of any of these albums. */
  albumIds?: string[];
  withExif?: boolean;
  size?: number;
  /** `nextCursor` of the previous page; omit for the first page. */
  cursor?: string;
}

export interface MetadataPage {
  items: AssetResponseDto[];
  /** null on the last page. Opaque; currently offset-based (see docs/immich-api-notes.md §4.1). */
  nextCursor: string | null;
}

export interface SmartSearchQuery {
  query: string;
  /** Max assets to return, in rank order. */
  limit: number;
  type?: AssetTypeEnum;
  visibility?: AssetVisibility;
}

export interface AlbumRef {
  id: string;
  name: string;
  created: boolean;
}

/** An album of the API key's user, as `GET /albums` lists it. */
export interface AlbumSummary {
  id: string;
  name: string;
  description: string;
  assetCount: number;
  /** Local time of the earliest / latest asset (Immich serialises it as UTC); absent for empty albums. */
  startDate?: string;
  endDate?: string;
  lastModifiedAssetTimestamp?: string;
}

export interface AlbumWriteResult {
  /** Ids actually added/removed by this call. */
  succeeded: string[];
  /** Ids already in the desired state: `duplicate` on add, `not_found` on remove. */
  unchanged: string[];
  /** Ids Immich refused, e.g. `no_permission` for unknown or foreign assets. */
  failed: { id: string; error: string }[];
}

export interface OriginalHead {
  data: Uint8Array;
  /** true when Immich honoured the Range request (206). */
  partial: boolean;
  /** Full file size if known. */
  totalSize?: number;
}

export interface Thumbnail {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength?: number;
}

interface RequestContext {
  correlationId?: string;
}

const RETRYABLE_STATUS = (s: number) => s === 429 || s >= 500;

/**
 * The only place that knows Immich endpoint shapes. Wraps `@immich/sdk` with
 * retries, concurrency limits, chunking and typed errors.
 * All SDK calls get per-call options; the SDK's global `init()` is never used.
 */
export class ImmichClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: LoggerService;
  private readonly apiLimit: LimitFunction;
  private readonly fileLimit: LimitFunction;
  private readonly thumbnailLimit: LimitFunction;

  constructor(options: ImmichClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.retries = options.retries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.logger = options.logger ?? new Logger(ImmichClient.name);
    this.apiLimit = pLimit(options.apiConcurrency ?? 2);
    this.fileLimit = pLimit(options.fileConcurrency ?? 4);
    this.thumbnailLimit = pLimit(options.thumbnailConcurrency ?? 6);
  }

  // ---------------------------------------------------------------- server

  /** `GET /server/version` (needs no permission). */
  async getVersion(options: CallOptions = {}): Promise<ServerVersion> {
    const v = await this.call(
      'getServerVersion',
      (o) => getServerVersion(o),
      options,
    );
    return {
      major: v.major,
      minor: v.minor,
      patch: v.patch,
      version: `v${v.major}.${v.minor}.${v.patch}`,
    };
  }

  /**
   * Id of the API key's user (`GET /users/me`, needs `user.read`). Metadata
   * search also returns assets of timeline-sharing partners, told apart by
   * `ownerId` (API notes §10.1).
   */
  async getMyUserId(options: CallOptions = {}): Promise<string> {
    const me = await this.call('getMyUser', (o) => getMyUser(o), options);
    return me.id;
  }

  /** Throws {@link ImmichIncompatibleError} unless the server is Immich v3.x. */
  async assertCompatible(options: CallOptions = {}): Promise<ServerVersion> {
    const version = await this.getVersion(options);
    if (version.major !== SUPPORTED_MAJOR)
      throw new ImmichIncompatibleError(version.version);
    return version;
  }

  // ---------------------------------------------------------------- search

  /**
   * One page of `POST /search/metadata`, using the v3.3 filter DSL and cursor
   * pagination, ordered by `fileCreatedAt` ascending.
   */
  async searchMetadataPage(
    query: MetadataPageQuery,
    options: CallOptions = {},
  ): Promise<MetadataPage> {
    const dto = buildMetadataSearch(query);
    const res = await this.call(
      'searchMetadata',
      (o) => searchAssets({ metadataSearchDto: dto }, o),
      options,
    );
    return {
      items: res.assets.items,
      nextCursor: res.assets.nextCursor ?? null,
    };
  }

  /**
   * CLIP search via `POST /search/smart`; returns asset ids in rank order.
   * Throws {@link ImmichSmartSearchUnavailableError} when Immich ML is down.
   */
  async searchSmart(
    query: SmartSearchQuery,
    options: CallOptions = {},
  ): Promise<string[]> {
    const size = Math.min(query.limit, SEARCH_PAGE_SIZE);
    const ids: string[] = [];
    // Smart search still pages by number (not verified on v3.3 without ML; see API notes §5).
    for (let page = 1; ids.length < query.limit; page++) {
      let res;
      try {
        res = await this.call(
          'searchSmart',
          (o) =>
            searchSmart(
              {
                smartSearchDto: {
                  query: query.query,
                  size,
                  page,
                  type: query.type,
                  visibility: query.visibility,
                },
              },
              o,
            ),
          options,
        );
      } catch (e) {
        if (e instanceof ImmichApiError && e.status === 500)
          throw new ImmichSmartSearchUnavailableError(e.correlationId);
        throw e;
      }
      ids.push(...res.assets.items.map((a) => a.id));
      if (!res.assets.nextPage || res.assets.items.length === 0) break;
    }
    return ids.slice(0, query.limit);
  }

  // ---------------------------------------------------------------- albums

  /** Finds an album owned by the API key's user by exact name; null if none. */
  async findAlbum(
    name: string,
    options: CallOptions = {},
  ): Promise<{ id: string; name: string } | null> {
    const albums = await this.call(
      'getAllAlbums',
      (o) => getAllAlbums({ name, isOwned: true }, o),
      options,
    );
    const matches = albums.filter((a) => a.albumName === name);
    if (matches.length > 1) {
      this.logger.warn(
        `${matches.length} albums named "${name}" found; using ${matches[0].id}`,
      );
    }
    return matches.length > 0 ? { id: matches[0].id, name } : null;
  }

  /** Finds an album owned by the API key's user by exact name, or creates it. */
  async findOrCreateAlbum(
    name: string,
    options: CallOptions & { description?: string } = {},
  ): Promise<AlbumRef> {
    const existing = await this.findAlbum(name, options);
    if (existing) return { ...existing, created: false };

    const created = await this.call(
      'createAlbum',
      (o) =>
        createAlbum(
          {
            createAlbumDto: {
              albumName: name,
              description: options.description,
            },
          },
          o,
        ),
      options,
    );
    this.logger.log(`Created album "${name}" (${created.id})`);
    return { id: created.id, name, created: true };
  }

  /** All albums owned by the API key's user, with dates for non-empty ones (API notes §10.5). */
  async listOwnedAlbums(options: CallOptions = {}): Promise<AlbumSummary[]> {
    const albums = await this.call(
      'getAllAlbums',
      (o) => getAllAlbums({ isOwned: true }, o),
      options,
    );
    return albums.map((a) => ({
      id: a.id,
      name: a.albumName,
      description: a.description ?? '',
      assetCount: a.assetCount,
      startDate: a.startDate,
      endDate: a.endDate,
      lastModifiedAssetTimestamp: a.lastModifiedAssetTimestamp,
    }));
  }

  /** `POST /albums`: a new album, even if one with that name exists. */
  async createAlbum(
    name: string,
    options: CallOptions & { description?: string } = {},
  ): Promise<{ id: string; name: string }> {
    const created = await this.call(
      'createAlbum',
      (o) =>
        createAlbum(
          {
            createAlbumDto: {
              albumName: name,
              description: options.description,
            },
          },
          o,
        ),
      options,
    );
    this.logger.log(`Created album "${name}" (${created.id})`);
    return { id: created.id, name };
  }

  /** `PATCH /albums/{id}` (needs `album.update`). */
  async renameAlbum(
    id: string,
    name: string,
    options: CallOptions = {},
  ): Promise<void> {
    await this.call(
      'updateAlbumInfo',
      (o) => updateAlbumInfo({ id, updateAlbumDto: { albumName: name } }, o),
      options,
    );
  }

  /** All asset ids in an album (v3 album responses no longer include assets). */
  async listAlbumMemberIds(
    albumId: string,
    options: CallOptions = {},
  ): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.searchMetadataPage(
        {
          albumIds: [albumId],
          // Explicit: omitting visibility also returns hidden assets (API notes §4.3);
          // album members can be in the timeline, archived or hidden (never locked).
          visibility: [
            AssetVisibility.Timeline,
            AssetVisibility.Archive,
            AssetVisibility.Hidden,
          ],
          size: SEARCH_PAGE_SIZE,
          cursor,
        },
        options,
      );
      for (const a of page.items) ids.push(a.id);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return ids;
  }

  /** `PUT /albums/{id}/assets` in chunks of {@link ALBUM_CHUNK_SIZE}. */
  addToAlbum(
    albumId: string,
    assetIds: string[],
    options: CallOptions = {},
  ): Promise<AlbumWriteResult> {
    return this.writeAlbumChunks(
      'addAssetsToAlbum',
      assetIds,
      'duplicate',
      options,
      (ids, o) => addAssetsToAlbum({ id: albumId, bulkIdsDto: { ids } }, o),
    );
  }

  /** `DELETE /albums/{id}/assets` in chunks of {@link ALBUM_CHUNK_SIZE}. */
  removeFromAlbum(
    albumId: string,
    assetIds: string[],
    options: CallOptions = {},
  ): Promise<AlbumWriteResult> {
    return this.writeAlbumChunks(
      'removeAssetFromAlbum',
      assetIds,
      'not_found',
      options,
      (ids, o) => removeAssetFromAlbum({ id: albumId, bulkIdsDto: { ids } }, o),
    );
  }

  // ---------------------------------------------------------------- files

  /**
   * First `bytes` of the original file. Sends a `Range` header; if Immich (or a
   * proxy) ignores it and answers 200, the stream is aborted after `bytes`.
   * Limited by the file-read concurrency.
   */
  readOriginalHead(
    assetId: string,
    options: CallOptions & { bytes?: number } = {},
  ): Promise<OriginalHead> {
    const bytes = options.bytes ?? ORIGINAL_HEAD_BYTES;
    return this.fileLimit(async () => {
      const ctx: RequestContext = {};
      const operation = 'readOriginalHead';
      const link = linkSignal(options.signal);
      try {
        const res = await this.rawGet(
          operation,
          `/assets/${encodeURIComponent(assetId)}/original`,
          ctx,
          { ...options, signal: link.signal },
          {
            Range: `bytes=0-${bytes - 1}`,
          },
        );
        return await readHead(res, bytes);
      } finally {
        link.release();
      }
    });
  }

  /**
   * `GET /assets/{id}/thumbnail` as a stream, for the backend's thumbnail proxy.
   * Limited by its own concurrency (default 6) so the review grid cannot
   * starve runs; the slot is held until the response headers arrive.
   */
  async getThumbnail(
    assetId: string,
    options: CallOptions = {},
  ): Promise<Thumbnail> {
    const ctx: RequestContext = {};
    const res = await this.thumbnailLimit(() =>
      this.rawGet(
        'getThumbnail',
        `/assets/${encodeURIComponent(assetId)}/thumbnail?size=thumbnail`,
        ctx,
        options,
      ),
    );
    const length = res.headers.get('content-length');
    return {
      body: res.body ?? new ReadableStream(),
      contentType:
        res.headers.get('content-type') ?? 'application/octet-stream',
      contentLength: length ? Number(length) : undefined,
    };
  }

  // ---------------------------------------------------------------- internals

  private async writeAlbumChunks(
    operation: string,
    assetIds: string[],
    benignError: string,
    options: CallOptions,
    send: (ids: string[], o: SdkOptions) => Promise<BulkIdResponseDto[]>,
  ): Promise<AlbumWriteResult> {
    const result: AlbumWriteResult = {
      succeeded: [],
      unchanged: [],
      failed: [],
    };
    for (const chunk of chunks(unique(assetIds), ALBUM_CHUNK_SIZE)) {
      const responses = await this.call(
        operation,
        (o) => send(chunk, o),
        options,
      );
      for (const r of responses) {
        if (r.success) result.succeeded.push(r.id);
        else if (r.error === benignError) result.unchanged.push(r.id);
        else
          result.failed.push({
            id: r.id,
            error: r.error ?? r.errorMessage ?? 'unknown',
          });
      }
    }
    if (result.failed.length > 0) {
      this.logger.warn(
        `${operation}: ${result.failed.length} id(s) refused, e.g. ${result.failed[0].id} (${result.failed[0].error})`,
      );
    }
    return result;
  }

  /** Runs one SDK call under the API limiter, mapping failures to {@link ImmichError}s. */
  private call<T>(
    operation: string,
    fn: (o: SdkOptions) => Promise<T>,
    options: CallOptions,
  ): Promise<T> {
    return this.apiLimit(async () => {
      const ctx: RequestContext = {};
      const link = linkSignal(options.signal);
      const signal = withTimeout(link.signal, options.timeoutMs);
      try {
        return await fn(
          this.sdkOptions(operation, ctx, signal, options.retry ?? true),
        );
      } catch (e) {
        throw this.toImmichError(operation, e, ctx, signal);
      } finally {
        link.release();
      }
    });
  }

  private sdkOptions(
    operation: string,
    ctx: RequestContext,
    signal: AbortSignal | undefined,
    retry: boolean,
  ): SdkOptions {
    return {
      baseUrl: this.baseUrl,
      headers: { 'x-api-key': this.apiKey },
      signal,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        this.fetchWithRetry(
          operation,
          input,
          init ?? {},
          ctx,
          retry,
        )) as typeof fetch,
    };
  }

  /** Plain GET for binary endpoints the SDK would buffer completely. */
  private async rawGet(
    operation: string,
    path: string,
    ctx: RequestContext,
    options: CallOptions,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const signal = withTimeout(options.signal, options.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchWithRetry(
        operation,
        `${this.baseUrl}${path}`,
        { headers: { 'x-api-key': this.apiKey, ...headers }, signal },
        ctx,
        options.retry ?? true,
      );
    } catch (e) {
      throw this.toImmichError(operation, e, ctx, signal);
    }
    if (!res.ok) {
      const body = await res.text().then(tryJson, () => undefined);
      const error = new ImmichApiError(
        operation,
        res.status,
        body,
        ctx.correlationId,
      );
      this.logger.warn(error.message);
      throw error;
    }
    return res;
  }

  private async fetchWithRetry(
    operation: string,
    input: RequestInfo | URL,
    init: RequestInit,
    ctx: RequestContext,
    retry: boolean,
  ): Promise<Response> {
    const maxAttempts = retry ? this.retries + 1 : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.fetchImpl(input, init);
        ctx.correlationId = res.headers.get('x-correlation-id') ?? undefined;
        if (RETRYABLE_STATUS(res.status) && attempt < maxAttempts) {
          const delay = this.retryDelay(
            attempt,
            res.headers.get('retry-after'),
          );
          this.logger.warn(
            `${operation}: HTTP ${res.status}${ctx.correlationId ? ` (correlation id ${ctx.correlationId})` : ''}, ` +
              `retry ${attempt}/${this.retries} in ${delay} ms`,
          );
          await res.body?.cancel().catch(() => undefined);
          await sleep(delay, init.signal ?? undefined);
          continue;
        }
        return res;
      } catch (e) {
        if (init.signal?.aborted || attempt >= maxAttempts) throw e;
        const delay = this.retryDelay(attempt, null);
        this.logger.warn(
          `${operation}: ${(e as Error).message}, retry ${attempt}/${this.retries} in ${delay} ms`,
        );
        await sleep(delay, init.signal ?? undefined);
      }
    }
  }

  private retryDelay(attempt: number, retryAfter: string | null): number {
    const fromHeader = parseRetryAfter(retryAfter);
    const backoff = this.retryBaseMs * 2 ** (attempt - 1);
    const jittered = backoff / 2 + Math.random() * (backoff / 2);
    return Math.round(Math.min(fromHeader ?? jittered, this.maxRetryDelayMs));
  }

  private toImmichError(
    operation: string,
    e: unknown,
    ctx: RequestContext,
    signal?: AbortSignal,
  ): unknown {
    if (signal?.aborted) return signal.reason ?? e; // cancellation/timeout: let callers see the abort reason
    if (e instanceof ImmichError) return e;
    if (isHttpError(e)) {
      const error = new ImmichApiError(
        operation,
        e.status,
        e.data,
        ctx.correlationId,
      );
      this.logger.warn(error.message);
      return error;
    }
    const error = new ImmichUnreachableError(operation, e);
    this.logger.warn(error.message);
    return error;
  }
}

type SdkOptions = {
  baseUrl: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  fetch: typeof fetch;
};

export function buildMetadataSearch(
  query: MetadataPageQuery,
): MetadataSearchDto {
  const filter: SearchFilter = {};
  if (query.type) filter.type = { eq: query.type };
  else if (query.types?.length) filter.type = { in: query.types };
  if (query.visibility) filter.visibility = { in: query.visibility };
  if (query.updatedAfter)
    filter.updatedAt = { gt: query.updatedAfter.toISOString() };
  if (query.albumIds?.length) filter.albumIds = { any: query.albumIds };
  return {
    filter,
    orderBy: {
      field: SearchOrderField.FileCreatedAt,
      direction: AssetOrder.Asc,
    },
    withExif: query.withExif ?? false,
    size: query.size ?? SEARCH_PAGE_SIZE,
    ...(query.cursor ? { cursor: query.cursor } : {}),
  };
}

function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (!timeoutMs) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * A per-request signal that follows `parent`. Passing a long-lived signal (a
 * run's) straight to fetch makes undici add an abort listener per request that
 * stays until the run ends — tens of thousands of reads then pile up retained
 * memory. Call `release()` when the request (incl. its body) is done.
 */
export function linkSignal(parent: AbortSignal | undefined): {
  signal: AbortSignal | undefined;
  release(): void;
} {
  if (!parent) return { signal: undefined, release: () => {} };
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort(parent.reason);
    return { signal: controller.signal, release: () => {} };
  }
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    release: () => parent.removeEventListener('abort', onAbort),
  };
}

async function readHead(res: Response, bytes: number): Promise<OriginalHead> {
  const data = await readAtMost(res, bytes);
  const range = res.headers.get('content-range');
  const total =
    range?.match(/\/(\d+)$/)?.[1] ??
    (res.status === 200 ? res.headers.get('content-length') : null);
  return {
    data,
    partial: res.status === 206,
    totalSize: total ? Number(total) : undefined,
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readAtMost(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const out = new Uint8Array(max);
  let length = 0;
  try {
    while (length < max) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, max - length);
      out.set(value.subarray(0, take), length);
      length += take;
    }
  } finally {
    // Stops the download if the server sent more than we need (no Range support).
    await reader.cancel().catch(() => undefined);
  }
  return out.slice(0, length);
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
