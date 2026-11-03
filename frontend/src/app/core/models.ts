/** API shapes (mirrors backend/src/api). */

export type SyncMode = 'dry-run' | 'additive' | 'mirror';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export const TERMINAL_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
];
export const isActive = (s: RunStatus) => s === 'queued' || s === 'running';

export interface JobType {
  id: string;
  name: string;
  description?: string;
  version: number;
  paramsSchema: Record<string, unknown>;
  defaultParams: Record<string, unknown>;
}

export interface Run {
  id: string;
  jobId: string;
  status: RunStatus;
  trigger: string;
  dryRun: boolean;
  fullRescan: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  since: string | null;
  cursor: string | null;
  scanned: number;
  matched: number;
  added: number;
  removed: number;
  filesRead: number;
  cacheHits: number;
  error: string | null;
  /** Dry runs: when the selection was last applied to the album. */
  appliedAt: string | null;
}

export interface ApplyPreview {
  albumName: string;
  albumExists: boolean;
  exclusionAlbumName: string;
  selected: number;
  alreadyInAlbum: number;
  excluded: number;
  toAdd: number;
}

export interface ApplyResult {
  albumName: string;
  albumCreated: boolean;
  selected: number;
  added: number;
  alreadyInAlbum: number;
  excluded: number;
  failed: number;
}

export interface Job {
  id: string;
  name: string;
  typeId: string;
  typeVersion: number;
  params: Record<string, unknown>;
  targetAlbumName: string;
  exclusionAlbumName: string | null;
  effectiveExclusionAlbumName: string;
  syncMode: SyncMode;
  schedule: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRun: Run | null;
  /** Next scheduled run (enabled jobs with a schedule). */
  nextRunAt: string | null;
}

export interface JobInput {
  name: string;
  typeId?: string;
  targetAlbumName: string;
  exclusionAlbumName: string | null;
  params: Record<string, unknown>;
  syncMode: SyncMode;
  schedule: string | null;
  enabled: boolean;
}

export interface RunLog {
  id: number;
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export interface Candidate {
  assetId: string;
  score: number;
  reasons: string[];
  originalFileName: string | null;
  selected: boolean;
}

export interface CandidateSummary {
  all: number;
  selected: number;
  unselected: number;
  high: number;
  medium: number;
}

export type CandidateSort = '-score' | 'score' | 'name';

export interface CandidateFilter {
  minScore?: number;
  maxScore?: number;
  selected?: boolean;
}

export interface Health {
  status: 'ok' | 'degraded' | 'error';
  database: { status: 'up' | 'down'; error?: string };
  immich: {
    status: 'up' | 'down' | 'incompatible';
    version?: string;
    error?: string;
    correlationId?: string;
  };
}

export interface Totals {
  scanned: number;
  matched: number;
  added: number;
  removed: number;
  filesRead: number;
  cacheHits: number;
}

export type RunEvent =
  | { type: 'status'; data: { status: RunStatus; error: string | null } & Partial<Totals> }
  | { type: 'progress'; data: Totals }
  | { type: 'log'; data: { level: RunLog['level']; message: string; ts: string } };

/** Backend validation error body. */
export interface FieldError {
  path: (string | number)[];
  message: string;
}
