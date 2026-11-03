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

export type JobKind = 'assets' | 'groups';

export interface JobType {
  id: string;
  /** `groups`: one album per group (e.g. trip albums), no target album. */
  kind: JobKind;
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
  typeKind: JobKind;
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
  /** Asset jobs only; group jobs create one album per group. */
  targetAlbumName?: string;
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
  /** Group jobs: only the assets of this proposed group. */
  group?: string;
}

export interface Health {
  status: 'ok' | 'degraded' | 'error';
  version?: string;
  /** Only with a session (or in forward-auth mode). */
  database?: { status: 'up' | 'down'; error?: string };
  immich?: {
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

export interface AuthSession {
  mode: 'password' | 'forward-auth';
  authenticated: boolean;
}

export type SettingKey = 'retention.dryRunCandidates' | 'retention.logDays' | 'defaults.threshold';

export interface SettingsView {
  settings: Record<SettingKey, number>;
  app: {
    version: string;
    authMode: 'password' | 'forward-auth';
    timeZone: string;
    maxConcurrentRuns: number;
    maxFileReads: number;
    immichUrl: string;
  };
}

export interface ImportResult {
  created: string[];
  skipped: string[];
  failed: { index: number; name?: string; errors: FieldError[] }[];
}

// ---------------------------------------------------------------- group jobs (trip albums)

export type GroupAction = 'create' | 'update' | 'ignored' | 'locked' | 'orphaned' | 'merged';
export type GroupStatus = 'active' | 'ongoing' | 'ignored' | 'orphaned' | 'merged' | 'locked';

/** Trip albums summary values (other group types may add their own). */
export interface GroupSummary {
  countries?: string[];
  cities?: string[];
  days?: number;
  /** Local wall-clock times, ISO without zone. */
  localStart?: string;
  localEnd?: string;
  startRule?: string;
  endRule?: string;
  /** `create`: proposed existing album to adopt. */
  adoptAlbumId?: string;
  adoptAlbumName?: string;
  /** `merged`: the group that took over. */
  mergedIntoName?: string;
  [key: string]: unknown;
}

/** A proposed group of a dry run (`GET /runs/:id/groups`). */
export interface RunGroup {
  key: string;
  action: GroupAction;
  jobGroupId: string | null;
  /** Album of the matched group, or the adopted album for `create`. */
  albumId: string | null;
  name: string;
  start: string;
  end: string;
  coreStart: string;
  coreEnd: string;
  ongoing: boolean;
  summary: GroupSummary;
  assetCount: number;
  selected: boolean;
}

export interface RunGroupsResponse {
  items: RunGroup[];
  summary: Record<GroupAction, number> & { selected: number };
}

/** A stored group of a job (`GET /jobs/:id/groups`). */
export interface JobGroup {
  id: string;
  key: string;
  status: GroupStatus;
  name: string;
  albumId: string | null;
  nameLocked: boolean;
  adopted: boolean;
  start: string;
  end: string;
  coreStart: string;
  coreEnd: string;
  summary: GroupSummary;
  assetCount: number;
  excludedCount: number;
}

export interface GroupApplyPreview {
  kind: 'groups';
  selected: number;
  create: number;
  adopt: number;
  update: number;
  ignore: number;
  assets: number;
}

export interface GroupSyncResult {
  created: number;
  adopted: number;
  updated: number;
  renamed: number;
  ignored: number;
  orphaned: number;
  merged: number;
  added: number;
  removed: number;
  removedByHand: number;
  addedByHand: number;
  failed: number;
}

export interface GroupApplyResult {
  kind: 'groups';
  result: GroupSyncResult;
  summary: string;
}

/** Trip albums insights: inferred home per month. */
export interface TripInsights {
  home: { from: string; to: string; country: string | null; place: string | null }[];
}
