import type {
  IndexedAsset,
  IndexType,
  IndexVisibility,
} from './asset-index.mapping.js';

/** Which index rows a job reads. */
export interface IndexReadFilter {
  /** The API key's user (`ImmichClient.getMyUserId()`). */
  ownerId: string;
  /** Also read assets of timeline-sharing partners (their timeline assets only: archived ones can't be added to albums, API notes §10.2). */
  includePartners?: boolean;
  /** Default: images and videos. */
  types?: IndexType[];
  /** Own archived assets too (default false). */
  includeArchived?: boolean;
}

/** Does `asset` pass `filter`? */
export function matchesFilter(
  asset: IndexedAsset,
  filter: IndexReadFilter,
): boolean {
  const own = asset.ownerId === filter.ownerId;
  if (!own && !filter.includePartners) return false;
  if (filter.types && !filter.types.includes(asset.type)) return false;
  const visible: IndexVisibility[] =
    own && filter.includeArchived ? ['timeline', 'archive'] : ['timeline'];
  return visible.includes(asset.visibility);
}

/**
 * Read-only, in-memory view of the index ordered by `takenAt` (then id).
 * About 200 bytes per asset, so 100k assets fit easily (SDD §4).
 */
export class AssetIndexReader {
  private readonly assets: readonly IndexedAsset[];

  constructor(assets: IndexedAsset[]) {
    this.assets = [...assets].sort(
      (a, b) =>
        a.takenAt - b.takenAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  get size(): number {
    return this.assets.length;
  }

  /** All assets in `takenAt` order. */
  all(): readonly IndexedAsset[] {
    return this.assets;
  }

  /** Assets with `start <= takenAt < end` (ms or Date), in order. */
  between(start: number | Date, end: number | Date): IndexedAsset[] {
    const from = this.lowerBound(+start);
    const to = this.lowerBound(+end);
    return this.assets.slice(from, to);
  }

  /** First index whose `takenAt` is >= `t`. */
  private lowerBound(t: number): number {
    let lo = 0;
    let hi = this.assets.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.assets[mid].takenAt < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
