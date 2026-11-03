import type { z } from 'zod';
import type { ImmichClient } from '../immich/immich.client.js';

/**
 * A job type: code that selects assets. Implementations are Nest providers
 * marked with `@AlbumJobType()` and discovered at boot.
 */
export interface JobType<P = unknown> {
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
