import { Global, Injectable, Module, NotFoundException } from '@nestjs/common';
import type {
  GroupAction,
  GroupStatus,
} from '../persistence/entities/index.js';
import { SqliteService, sqliteNow } from '../persistence/sqlite.service.js';
import type { ExistingGroup, ReconcileItem } from './group-reconciler.js';

/** A stored group, incl. what the review list shows. */
export interface StoredGroup extends ExistingGroup {
  key: string;
  start: Date;
  end: Date;
  summary: Record<string, unknown>;
  nameLocked: boolean;
  adopted: boolean;
}

export interface RunGroupView {
  key: string;
  action: GroupAction;
  jobGroupId: string | null;
  albumId: string | null;
  name: string;
  start: string;
  end: string;
  coreStart: string;
  coreEnd: string;
  ongoing: boolean;
  summary: Record<string, unknown>;
  assetCount: number;
  selected: boolean;
}

export interface JobGroupView {
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
  summary: Record<string, unknown>;
  /** Assets in the album as the job knows them (owned + present). */
  assetCount: number;
  excludedCount: number;
}

/** Actions whose assets go into an album on apply (and can be ticked). */
export const SELECTABLE_ACTIONS: readonly GroupAction[] = ['create', 'update'];

/** TypeORM's SQLite datetime → ISO. */
const iso = (v: string) => `${v.replace(' ', 'T')}Z`;
const date = (v: string) => new Date(iso(v));

/**
 * Persistence for group jobs (trip-albums SDD §7.1): stored groups
 * (`job_group`, `job_group_asset`) and a dry run's proposals (`run_group`,
 * `run_candidate.group_key`). Writes are synchronous SQLite transactions.
 */
@Injectable()
export class GroupStore {
  constructor(private readonly sqlite: SqliteService) {}

  /** All stored groups of a job with the assets their album holds as far as the job knows. */
  loadExisting(jobId: string): StoredGroup[] {
    const db = this.sqlite.db;
    const rows = db
      .prepare(
        `SELECT id, key, status, start_at, end_at, core_start_at, core_end_at, summary, album_id,
                generated_name, name_locked, adopted
         FROM job_group WHERE job_id = ? ORDER BY core_start_at, id`,
      )
      .all(jobId) as {
      id: string;
      key: string;
      status: GroupStatus;
      start_at: string;
      end_at: string;
      core_start_at: string;
      core_end_at: string;
      summary: string;
      album_id: string | null;
      generated_name: string;
      name_locked: number;
      adopted: number;
    }[];
    const assets = db.prepare(
      `SELECT asset_id, state FROM job_group_asset WHERE group_id = ? AND state IN ('owned', 'present')`,
    );
    return rows.map((r) => {
      const members = assets.all(r.id) as { asset_id: string; state: string }[];
      return {
        id: r.id,
        key: r.key,
        status: r.status,
        start: date(r.start_at),
        end: date(r.end_at),
        coreStart: date(r.core_start_at),
        coreEnd: date(r.core_end_at),
        summary: JSON.parse(r.summary) as Record<string, unknown>,
        albumId: r.album_id,
        name: r.generated_name,
        nameLocked: r.name_locked === 1,
        adopted: r.adopted === 1,
        assetIds: new Set(members.map((m) => m.asset_id)),
        ownedCount: members.filter((m) => m.state === 'owned').length,
      };
    });
  }

  /**
   * Stores a dry run's reconciled groups (replacing earlier rows of the run,
   * e.g. after a resume): one `run_group` row per item, one `run_candidate`
   * row per asset of a selectable group. Returns the number of those assets.
   */
  storeDryRun(
    runId: string,
    items: readonly ReconcileItem[],
    fileNames: ReadonlyMap<string, string>,
  ): number {
    return this.sqlite.transaction((db) => {
      db.prepare('DELETE FROM run_candidate WHERE run_id = ?').run(runId);
      db.prepare('DELETE FROM run_group WHERE run_id = ?').run(runId);
      const group = db.prepare(
        `INSERT INTO run_group (run_id, group_key, action, job_group_id, album_id, name, start_at, end_at,
           core_start_at, core_end_at, ongoing, summary, asset_count, selected)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const candidate = db.prepare(
        `INSERT INTO run_candidate (run_id, asset_id, score, reasons, original_file_name, selected, group_key)
         VALUES (?, ?, 1, ?, ?, 1, ?) ON CONFLICT (run_id, asset_id) DO NOTHING`,
      );
      let matched = 0;
      for (const item of items) {
        const p = item.proposed;
        const e = item.existing as StoredGroup | undefined;
        const selectable = SELECTABLE_ACTIONS.includes(item.action);
        const key = p?.key ?? `group:${e!.id}`;
        const range = p ?? {
          start: e!.start,
          end: e!.end,
          coreStart: e!.coreStart,
          coreEnd: e!.coreEnd,
        };
        group.run(
          runId,
          key,
          item.action,
          e?.id ?? null,
          e?.albumId ?? null,
          p?.name ?? e!.name,
          sqliteNow(range.start),
          sqliteNow(range.end),
          sqliteNow(range.coreStart),
          sqliteNow(range.coreEnd),
          p?.ongoing ? 1 : 0,
          JSON.stringify({
            ...(p?.summary ?? e?.summary),
            ...(item.mergedInto
              ? {
                  mergedInto: item.mergedInto.id,
                  mergedIntoName: item.mergedInto.name,
                }
              : {}),
          }),
          p?.assets.length ?? e!.assetIds.size,
          selectable ? 1 : 0,
        );
        if (!selectable || !p) continue;
        for (const a of p.assets) {
          const res = candidate.run(
            runId,
            a.assetId,
            JSON.stringify(a.reasons),
            fileNames.get(a.assetId) ?? null,
            key,
          );
          matched += res.changes;
        }
      }
      return matched;
    });
  }

  listRunGroups(runId: string): RunGroupView[] {
    const rows = this.sqlite.db
      .prepare(
        `SELECT group_key, action, job_group_id, album_id, name, start_at, end_at, core_start_at, core_end_at,
                ongoing, summary, asset_count, selected
         FROM run_group WHERE run_id = ? ORDER BY core_start_at, group_key`,
      )
      .all(runId) as {
      group_key: string;
      action: GroupAction;
      job_group_id: string | null;
      album_id: string | null;
      name: string;
      start_at: string;
      end_at: string;
      core_start_at: string;
      core_end_at: string;
      ongoing: number;
      summary: string;
      asset_count: number;
      selected: number;
    }[];
    return rows.map((r) => ({
      key: r.group_key,
      action: r.action,
      jobGroupId: r.job_group_id,
      albumId: r.album_id,
      name: r.name,
      start: iso(r.start_at),
      end: iso(r.end_at),
      coreStart: iso(r.core_start_at),
      coreEnd: iso(r.core_end_at),
      ongoing: r.ongoing === 1,
      summary: JSON.parse(r.summary) as Record<string, unknown>,
      assetCount: r.asset_count,
      selected: r.selected === 1,
    }));
  }

  /** Ticks/unticks selectable groups (all of them when `keys` is omitted). */
  selectRunGroups(runId: string, selected: boolean, keys?: string[]): number {
    const actions = SELECTABLE_ACTIONS.map((a) => `'${a}'`).join(',');
    return this.sqlite.transaction((db) => {
      if (!keys)
        return db
          .prepare(
            `UPDATE run_group SET selected = ? WHERE run_id = ? AND action IN (${actions})`,
          )
          .run(selected ? 1 : 0, runId).changes;
      const stmt = db.prepare(
        `UPDATE run_group SET selected = ? WHERE run_id = ? AND group_key = ? AND action IN (${actions})`,
      );
      let n = 0;
      for (const key of new Set(keys))
        n += stmt.run(selected ? 1 : 0, runId, key).changes;
      return n;
    });
  }

  listJobGroups(jobId: string): JobGroupView[] {
    const rows = this.sqlite.db
      .prepare(
        `SELECT g.id, g.key, g.status, g.generated_name, g.album_id, g.name_locked, g.adopted,
                g.start_at, g.end_at, g.core_start_at, g.core_end_at, g.summary,
                (SELECT COUNT(*) FROM job_group_asset a WHERE a.group_id = g.id AND a.state IN ('owned', 'present')) AS asset_count,
                (SELECT COUNT(*) FROM job_group_asset a WHERE a.group_id = g.id AND a.state = 'excluded') AS excluded_count
         FROM job_group g WHERE g.job_id = ? ORDER BY g.core_start_at, g.id`,
      )
      .all(jobId) as {
      id: string;
      key: string;
      status: GroupStatus;
      generated_name: string;
      album_id: string | null;
      name_locked: number;
      adopted: number;
      start_at: string;
      end_at: string;
      core_start_at: string;
      core_end_at: string;
      summary: string;
      asset_count: number;
      excluded_count: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      status: r.status,
      name: r.generated_name,
      albumId: r.album_id,
      nameLocked: r.name_locked === 1,
      adopted: r.adopted === 1,
      start: iso(r.start_at),
      end: iso(r.end_at),
      coreStart: iso(r.core_start_at),
      coreEnd: iso(r.core_end_at),
      summary: JSON.parse(r.summary) as Record<string, unknown>,
      assetCount: r.asset_count,
      excludedCount: r.excluded_count,
    }));
  }

  /** User decision on a stored group: `ignored`, `locked`, or back to `active`. */
  setJobGroupStatus(
    jobId: string,
    groupId: string,
    status: 'ignored' | 'locked' | 'active',
  ): JobGroupView {
    const { changes } = this.sqlite.db
      .prepare(
        `UPDATE job_group SET status = ?, updated_at = ? WHERE id = ? AND job_id = ?`,
      )
      .run(status, sqliteNow(), groupId, jobId);
    if (changes === 0)
      throw new NotFoundException(`Group ${groupId} not found in job ${jobId}`);
    return this.listJobGroups(jobId).find((g) => g.id === groupId)!;
  }
}

@Global()
@Module({ providers: [GroupStore], exports: [GroupStore] })
export class GroupsModule {}
