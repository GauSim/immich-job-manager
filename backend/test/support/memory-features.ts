import type {
  AssetFeatureCache,
  AssetFeatures,
  AssetKey,
} from '../../src/features/asset-feature-cache.js';

/** In-memory AssetFeatureCache with the same checksum semantics. */
export class MemoryFeatureCache {
  readonly rows = new Map<string, { checksum: string } & AssetFeatures>();

  getMany(assets: AssetKey[]): Map<string, AssetFeatures> {
    const out = new Map<string, AssetFeatures>();
    for (const a of assets) {
      const row = this.rows.get(a.id);
      if (row && row.checksum === a.checksum)
        out.set(a.id, { iosScreenshotTag: row.iosScreenshotTag });
    }
    return out;
  }

  setMany(entries: (AssetKey & AssetFeatures)[]): void {
    for (const e of entries)
      this.rows.set(e.id, {
        checksum: e.checksum,
        iosScreenshotTag: e.iosScreenshotTag,
      });
  }

  asCache(): AssetFeatureCache {
    return this as unknown as AssetFeatureCache;
  }
}
