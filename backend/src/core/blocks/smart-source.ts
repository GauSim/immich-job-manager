import type {
  AssetTypeEnum,
  ImmichClient,
} from '../../immich/immich.client.js';
import { ImmichSmartSearchUnavailableError } from '../../immich/immich.errors.js';
import type { RunLogger } from '../job-type.js';
import type { Scorer } from './score.js';

/**
 * Runs each CLIP query once (`POST /search/smart`) and returns the best rank
 * (0 = top) per asset across all queries. Built once per run.
 * Returns an empty map (with a warning) when Immich ML is unavailable.
 */
export async function smartSource(
  immich: ImmichClient,
  queries: string[],
  options: {
    topN: number;
    type?: AssetTypeEnum;
    signal?: AbortSignal;
    log?: RunLogger;
  },
): Promise<Map<string, number>> {
  const ranks = new Map<string, number>();
  for (const query of queries) {
    let ids: string[];
    try {
      ids = await immich.searchSmart(
        { query, limit: options.topN, type: options.type },
        { signal: options.signal },
      );
    } catch (e) {
      if (e instanceof ImmichSmartSearchUnavailableError) {
        options.log?.warn(`${e.message}; continuing without the CLIP signal`);
        return new Map();
      }
      throw e;
    }
    ids.forEach((id, rank) => {
      const best = ranks.get(id);
      if (best === undefined || rank < best) ranks.set(id, rank);
    });
  }
  return ranks;
}

/** CLIP rank → `weight × (1 − rank / topN)` (top hit gets the full weight). */
export function rankScorer(
  ranks: Map<string, number>,
  options: { topN: number; weight: number; reason?: string },
): Scorer {
  const reason = options.reason ?? 'clip';
  return (asset) => {
    const rank = ranks.get(asset.id);
    if (rank === undefined) return null;
    const score =
      Math.round(options.weight * (1 - rank / options.topN) * 1000) / 1000;
    return score > 0 ? { score, reason } : null;
  };
}
