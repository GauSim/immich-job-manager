import type { z } from 'zod';
import type {
  AssetIndexReader,
  IndexReadFilter,
} from '../asset-index/asset-index.reader.js';
import type { AssetFeatureCache } from '../features/asset-feature-cache.js';
import type { ImmichClient } from '../immich/immich.client.js';

/**
 * A job type: code that selects assets. Implementations are Nest providers
 * marked with `@AlbumJobType()` and discovered at boot.
 */
export interface JobType<P = unknown> {
  /** Asset jobs (the default): score assets one by one into one album. */
  readonly kind?: 'assets';
  /** Stable id stored on jobs, e.g. `screenshot-detector`. */
  readonly id: string;
  /** Shown in the UI. */
  readonly name: string;
  readonly description?: string;
  /** Bump when selection logic changes; forces a full rescan (phase 7). */
  readonly version: number;
  /** Validates job params; its JSON Schema drives the UI form. */
  readonly params: z.ZodType<P>;
  readonly defaultParams: P;
  /**
   * Yields results page by page. The runner persists each batch (and its
   * cursor) before pulling the next one, so implementations must be lazy:
   * fetch one page, yield it, then fetch the next.
   */
  select(ctx: JobContext<P>): AsyncIterable<CandidateBatch>;
}

export interface Candidate {
  assetId: string;
  /** 0..1 */
  score: number;
  /** Signals that contributed, e.g. `['ios-tag', 'png']`. */
  reasons: string[];
  /** Original file name, shown in the review grid. */
  fileName?: string;
}

export interface CandidateBatch {
  /** Matched assets of this page (score ≥ threshold). */
  candidates: Candidate[];
  /** Assets looked at in this page. */
  scanned: number;
  /** Resume point after this page; null when the source is exhausted. */
  cursor: string | null;
  /** Optional extra counters for this page. */
  filesRead?: number;
  cacheHits?: number;
}

export interface JobContext<P> {
  readonly runId: string;
  readonly jobId: string;
  readonly params: P;
  readonly immich: ImmichClient;
  /** Per-asset cache of expensive signals (e.g. the iOS tag read from files). */
  readonly features: AssetFeatureCache;
  /** Set for incremental runs: only assets updated after this time. */
  readonly since?: Date;
  /** Cursor of an interrupted run to continue from. */
  readonly resumeFrom?: string;
  readonly dryRun: boolean;
  readonly log: RunLogger;
  /** Aborted on cancel or shutdown; pass it to every Immich call. */
  readonly signal: AbortSignal;
}

/** Log lines shown on the run detail page (and written to the app log). */
export interface RunLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * A group job type (trip-albums SDD §3.3): reads the whole asset index and
 * returns groups of assets, each synced to its own album (e.g. one per trip).
 * `group()` must be pure: no Immich calls, same input → same groups.
 */
export interface GroupJobType<P = unknown> {
  readonly kind: 'groups';
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Bump when grouping logic changes. */
  readonly version: number;
  readonly params: z.ZodType<P>;
  readonly defaultParams: P;
  /** Which index rows the job reads; the index itself always holds everything (T1). */
  indexFilter(params: P, ownerId: string): IndexReadFilter;
  /** All groups of the library, ordered by `coreStart`. */
  group(ctx: GroupContext<P>): Promise<ProposedGroup[]> | ProposedGroup[];
  /** Reuse existing albums that already cover a new group (SDD §7.4); null/absent = never. */
  adoption?(params: P): { minShare: number; minCoverage: number } | null;
  /** Optional insight for the job page (e.g. inferred home per period). */
  insights?(ctx: Omit<GroupContext<P>, 'log' | 'signal'>): unknown;
}

export type AnyJobType = JobType | GroupJobType;

export function isGroupJobType(type: AnyJobType): type is GroupJobType {
  return type.kind === 'groups';
}

export interface GroupContext<P> {
  readonly params: P;
  readonly index: AssetIndexReader;
  /** The API key's user; other owners are partners. */
  readonly ownerId: string;
  readonly now: Date;
  readonly log: RunLogger;
  readonly signal: AbortSignal;
}

export interface GroupAsset {
  assetId: string;
  /** e.g. `['gps-away']`, `['no-gps-camera', 'transit-departure']` */
  reasons: string[];
}

export interface ProposedGroup {
  /** Deterministic from content (e.g. `trip:2026-03-04`); unique within one run. Reconcile matches by overlap, not by key. */
  key: string;
  /** Group range (instants, inclusive). */
  start: Date;
  end: Date;
  /** Core range used to match groups across runs (e.g. first/last photo away). */
  coreStart: Date;
  coreEnd: Date;
  /** Still growing (e.g. a trip in progress). */
  ongoing: boolean;
  /** Generated album name. */
  name: string;
  /** Type-specific values for the review UI (countries, cities, days, …). */
  summary: Record<string, unknown>;
  assets: GroupAsset[];
}
