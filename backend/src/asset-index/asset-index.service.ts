import { Injectable, Module } from '@nestjs/common';
import { metadataSource } from '../core/blocks/metadata-source.js';
import {
  AssetTypeEnum,
  AssetVisibility,
  ImmichClient,
} from '../immich/immich.client.js';
import { SqliteService, sqliteNow } from '../persistence/sqlite.service.js';
import {
  toIndexRow,
  type IndexedAsset,
  type IndexRow,
} from './asset-index.mapping.js';
import {
  AssetIndexReader,
  matchesFilter,
  type IndexReadFilter,
} from './asset-index.reader.js';

export interface IndexRefreshOptions {
  /**
   * Start of this refresh, stored on every row it sees. A resumed refresh must
   * pass the same value (e.g. the run's start) so `completeRefresh` keeps the
   * rows written before the interruption.
   */
  startedAt: Date;
  /** Cursor of an interrupted refresh to continue from. */
  resumeFrom?: string;
  signal?: AbortSignal;
}

export interface IndexRefreshPage {
  /** Assets returned by Immich in this page. */
  scanned: number;
  /** Of those, rows written to the index (in scope). */
  indexed: number;
  /** Resume point after this page; null on the last page. */
  cursor: string | null;
}

export interface IndexRefreshTotals {
  scanned: number;
  indexed: number;
  /** Rows deleted because Immich no longer returned them. */
  removed: number;
}

const CHUNK = 500;

interface DbRow {
  asset_id: string;
  owner_id: string;
  type: string;
  visibility: string;
  taken_at: string;
  local_date_time: string;
  time_zone: string | null;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  has_camera: number;
  is_screenshot: number;
  file_name: string;
}

/** TypeORM's SQLite datetime (`YYYY-MM-DD HH:MM:SS.sss`, UTC) → ms. */
function fromSqlite(v: string): number {
  return Date.parse(`${v.replace(' ', 'T')}Z`);
}

/**
 * The asset index (`asset_index`, trip-albums SDD §4): a local copy of the
 * metadata group jobs need, for all images and videos in the timeline or
 * archive, including timeline-sharing partners' assets. Jobs narrow it down
 * when reading ({@link IndexReadFilter}).
 *
 * Refreshes are full: a walk of 32k assets takes ~8 s (API notes §10.6), so
 * there is no incremental refresh. Rows not seen by a completed refresh are
 * deleted, which drops assets deleted or trashed in Immich.
 */
@Injectable()
export class AssetIndexService {
  constructor(
    private readonly immich: ImmichClient,
    private readonly sqlite: SqliteService,
  ) {}

  /**
   * Walks the library page by page, upserting each page in one transaction.
   * Lazy: the next page is only fetched once the consumer asks for it, so the
   * caller can persist the cursor first. Call {@link completeRefresh} after
   * the last page.
   */
  async *refresh(
    options: IndexRefreshOptions,
  ): AsyncGenerator<IndexRefreshPage> {
    for await (const page of metadataSource(
      this.immich,
      {
        types: [AssetTypeEnum.Image, AssetTypeEnum.Video],
        visibility: [AssetVisibility.Timeline, AssetVisibility.Archive],
        withExif: true,
      },
      { resumeFrom: options.resumeFrom, signal: options.signal },
    )) {
      const rows = page.assets
        .map(toIndexRow)
        .filter((r): r is IndexRow => r !== null);
      this.upsert(rows, options.startedAt);
      yield {
        scanned: page.assets.length,
        indexed: rows.length,
        cursor: page.cursor,
      };
    }
  }

  /** After a complete refresh: deletes rows it did not see. Returns how many. */
  completeRefresh(startedAt: Date): number {
    return this.sqlite.db
      .prepare(`DELETE FROM asset_index WHERE indexed_at < ?`)
      .run(sqliteNow(startedAt)).changes;
  }

  /** Full refresh in one go (no resume): refresh + completeRefresh. */
  async refreshAll(
    options: { signal?: AbortSignal; startedAt?: Date } = {},
  ): Promise<IndexRefreshTotals> {
    const startedAt = options.startedAt ?? new Date();
    const totals = { scanned: 0, indexed: 0, removed: 0 };
    for await (const page of this.refresh({
      startedAt,
      signal: options.signal,
    })) {
      totals.scanned += page.scanned;
      totals.indexed += page.indexed;
    }
    totals.removed = this.completeRefresh(startedAt);
    return totals;
  }

  /** Drops rows of assets Immich refused (e.g. deleted since the last refresh). */
  forget(assetIds: string[]): number {
    if (assetIds.length === 0) return 0;
    return this.sqlite.transaction((db) => {
      let changes = 0;
      for (let i = 0; i < assetIds.length; i += CHUNK) {
        const chunk = assetIds.slice(i, i + CHUNK);
        changes += db
          .prepare(
            `DELETE FROM asset_index WHERE asset_id IN (${chunk.map(() => '?').join(',')})`,
          )
          .run(...chunk).changes;
      }
      return changes;
    });
  }

  count(): number {
    const row = this.sqlite.db
      .prepare(`SELECT COUNT(*) AS n FROM asset_index`)
      .get() as { n: number };
    return row.n;
  }

  /** Loads the rows passing `filter` into an ordered in-memory reader. */
  read(filter: IndexReadFilter): AssetIndexReader {
    // Streamed, so the raw rows are never all in memory next to the mapped ones.
    const rows = this.sqlite.db
      .prepare(
        `SELECT asset_id, owner_id, type, visibility, taken_at, local_date_time, time_zone,
                latitude, longitude, city, state, country, has_camera, is_screenshot, file_name
         FROM asset_index`,
      )
      .iterate() as IterableIterator<DbRow>;
    const assets: IndexedAsset[] = [];
    for (const r of rows) {
      const asset: IndexedAsset = {
        id: r.asset_id,
        ownerId: r.owner_id,
        type: r.type as IndexedAsset['type'],
        visibility: r.visibility as IndexedAsset['visibility'],
        takenAt: fromSqlite(r.taken_at),
        localDateTime: r.local_date_time,
        timeZone: r.time_zone,
        latitude: r.latitude,
        longitude: r.longitude,
        city: r.city,
        state: r.state,
        country: r.country,
        hasCamera: r.has_camera === 1,
        isScreenshot: r.is_screenshot === 1,
        fileName: r.file_name,
      };
      if (matchesFilter(asset, filter)) assets.push(asset);
    }
    return new AssetIndexReader(assets);
  }

  private upsert(rows: IndexRow[], startedAt: Date): void {
    if (rows.length === 0) return;
    const indexedAt = sqliteNow(startedAt);
    this.sqlite.transaction((db) => {
      const stmt = db.prepare(
        `INSERT INTO asset_index (asset_id, owner_id, type, visibility, taken_at, local_date_time, time_zone,
           latitude, longitude, city, state, country, has_camera, is_screenshot, file_name, immich_updated_at, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (asset_id) DO UPDATE SET
           owner_id = excluded.owner_id, type = excluded.type, visibility = excluded.visibility,
           taken_at = excluded.taken_at, local_date_time = excluded.local_date_time, time_zone = excluded.time_zone,
           latitude = excluded.latitude, longitude = excluded.longitude, city = excluded.city,
           state = excluded.state, country = excluded.country, has_camera = excluded.has_camera,
           is_screenshot = excluded.is_screenshot, file_name = excluded.file_name,
           immich_updated_at = excluded.immich_updated_at, indexed_at = excluded.indexed_at`,
      );
      for (const r of rows) {
        stmt.run(
          r.id,
          r.ownerId,
          r.type,
          r.visibility,
          sqliteNow(new Date(r.takenAt)),
          r.localDateTime,
          r.timeZone,
          r.latitude,
          r.longitude,
          r.city,
          r.state,
          r.country,
          r.hasCamera ? 1 : 0,
          r.isScreenshot ? 1 : 0,
          r.fileName,
          sqliteNow(new Date(r.immichUpdatedAt)),
          indexedAt,
        );
      }
    });
  }
}

@Module({ providers: [AssetIndexService], exports: [AssetIndexService] })
export class AssetIndexModule {}
