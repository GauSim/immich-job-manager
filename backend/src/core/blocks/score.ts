import type { AssetResponseDto } from '../../immich/immich.client.js';

export interface ScoreContribution {
  /** Added to the total (0..1). */
  score: number;
  reason: string;
  /** Sets the final score to 1.0 regardless of other signals (e.g. iOS tag). */
  decisive?: boolean;
}

/** A synchronous signal on asset metadata. Returns null when it doesn't apply. */
export type Scorer = (
  asset: AssetResponseDto,
) => ScoreContribution | ScoreContribution[] | null;

export interface ScoreResult {
  /** Sum of contributions, capped to 0..1. */
  score: number;
  reasons: string[];
}

/** Runs all scorers and sums their contributions (capped at 1). */
export function scoreAsset(
  asset: AssetResponseDto,
  scorers: Scorer[],
): ScoreResult {
  let total = 0;
  let decisive = false;
  const reasons: string[] = [];
  for (const scorer of scorers) {
    const out = scorer(asset);
    for (const c of out == null ? [] : Array.isArray(out) ? out : [out]) {
      total += c.score;
      decisive ||= c.decisive === true;
      if (!reasons.includes(c.reason)) reasons.push(c.reason);
    }
  }
  const score = decisive ? 1 : Math.min(1, Math.max(0, total));
  return { score: Math.round(score * 1000) / 1000, reasons };
}
