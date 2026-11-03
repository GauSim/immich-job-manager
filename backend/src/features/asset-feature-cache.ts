import { Global, Injectable, Module } from '@nestjs/common';
import { SqliteService, sqliteNow } from '../persistence/sqlite.service.js';

export interface AssetFeatures {
  /** true/false once checked; null = not checked yet. */
  iosScreenshotTag: boolean | null;
}

export interface AssetKey {
  id: string;
  /** Immich asset checksum; a different checksum invalidates the cached features. */
  checksum: string;
}

const CHUNK = 500;

/**
 * Per-asset cache of expensive signals (`asset_feature`), keyed by asset id and
 * valid only while the asset's checksum is unchanged. So each original file is
 * read once and only again when it changes (SDD §6.2).
 */
@Injectable()
export class AssetFeatureCache {
  constructor(private readonly sqlite: SqliteService) {}

  /** Cached features for the assets whose checksum still matches. */
  /** Cached features for the assets whose checksum still matches (assets without checksum never hit). */
  getMany(assets: AssetKey[]): Map<string, AssetFeatures> {
    const wanted = new Map(
      assets.filter((a) => a.checksum).map((a) => [a.id, a.checksum]),
    );
    const out = new Map<string, AssetFeatures>();
    const ids = [...wanted.keys()];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const rows = this.sqlite.db
        .prepare(
          `SELECT asset_id, checksum, ios_screenshot_tag FROM asset_feature
           WHERE asset_id IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...chunk) as {
        asset_id: string;
        checksum: string;
        ios_screenshot_tag: number | null;
      }[];
      for (const r of rows) {
        if (wanted.get(r.asset_id) !== r.checksum) continue; // file changed → stale
        out.set(r.asset_id, {
          iosScreenshotTag:
            r.ios_screenshot_tag === null ? null : r.ios_screenshot_tag === 1,
        });
      }
    }
    return out;
  }

  /** Stores features; entries without a checksum are skipped (they could never be validated). */
  setMany(all: (AssetKey & AssetFeatures)[]): void {
    const entries = all.filter((e) => e.checksum);
    if (entries.length === 0) return;
    const now = sqliteNow();
    this.sqlite.transaction((db) => {
      const upsert = db.prepare(
        `INSERT INTO asset_feature (asset_id, checksum, ios_screenshot_tag, checked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (asset_id) DO UPDATE SET
           checksum = excluded.checksum, ios_screenshot_tag = excluded.ios_screenshot_tag, checked_at = excluded.checked_at`,
      );
      for (const e of entries) {
        upsert.run(
          e.id,
          e.checksum,
          e.iosScreenshotTag === null ? null : e.iosScreenshotTag ? 1 : 0,
          now,
        );
      }
    });
  }
}

@Global()
@Module({ providers: [AssetFeatureCache], exports: [AssetFeatureCache] })
export class FeaturesModule {}
