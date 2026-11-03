import { ConflictException, Injectable } from '@nestjs/common';
import { GroupStore, type StoredProposal } from '../groups/group-store.js';
import { ImmichClient } from '../immich/immich.client.js';
import type { JobEntity, JobRunEntity } from '../persistence/entities/index.js';
import { SqliteService, sqliteNow } from '../persistence/sqlite.service.js';
import { describeSync } from '../runner/group-run.js';
import { RunStore, type RunTotals } from '../runner/run-store.js';
import { exclusionAlbumName } from './album-sync.service.js';
import {
  GroupAlbumSync,
  type GroupSyncItem,
  type GroupSyncResult,
} from './group-album-sync.js';

export interface GroupApplyPreview {
  kind: 'groups';
  /** Ticked groups that get an album now. */
  selected: number;
  /** Of those: new albums, adopted existing albums, existing albums updated. */
  create: number;
  adopt: number;
  update: number;
  /** Unticked new / existing groups: remembered as ignored. */
  ignore: number;
  /** Assets in the ticked groups. */
  assets: number;
}

export interface GroupApplyResult {
  kind: 'groups';
  result: GroupSyncResult;
  summary: string;
  totals: RunTotals;
}

const date = (iso: string) => new Date(iso);

/**
 * Applies a reviewed group dry run (trip-albums SDD §7.3): ticked groups get
 * their album (created, adopted or updated), unticked ones are remembered as
 * ignored, orphaned/merged groups get their status. Never removes assets.
 * A dry run can be applied once, and only while no other sync has changed
 * the job's groups since it started (else it would duplicate albums).
 */
@Injectable()
export class GroupApplyService {
  constructor(
    private readonly groups: GroupStore,
    private readonly albums: GroupAlbumSync,
    private readonly immich: ImmichClient,
    private readonly store: RunStore,
    private readonly sqlite: SqliteService,
  ) {}

  preview(run: JobRunEntity): GroupApplyPreview {
    const p: GroupApplyPreview = {
      kind: 'groups',
      selected: 0,
      create: 0,
      adopt: 0,
      update: 0,
      ignore: 0,
      assets: 0,
    };
    for (const g of this.groups.listRunGroups(run.id)) {
      if (g.action !== 'create' && g.action !== 'update') continue;
      if (!g.selected) {
        p.ignore++;
        continue;
      }
      p.selected++;
      p.assets += g.assetCount;
      if (g.action === 'update') p.update++;
      else if (g.albumId) p.adopt++;
      else p.create++;
    }
    return p;
  }

  async apply(run: JobRunEntity, job: JobEntity): Promise<GroupApplyResult> {
    this.assertFresh(run, job);
    const proposals = this.groups.runProposals(run.id);
    const exclusion = await this.immich.findAlbum(exclusionAlbumName(job));
    const excluded = new Set(
      exclusion ? await this.immich.listAlbumMemberIds(exclusion.id) : [],
    );
    const logs: string[] = [];
    const log = {
      debug: () => {},
      info: (m: string) => void logs.push(m),
      warn: (m: string) => void logs.push(m),
      error: (m: string) => void logs.push(m),
    };
    const result = await this.albums.sync(job, proposals.map(toSyncItem), {
      mode: 'additive',
      runId: run.id,
      excluded,
      log,
    });
    this.store.recordApply(run.id, job.id, []);
    const totals = this.store.addSyncTotals(run.id, result.added, 0);
    return { kind: 'groups', result, summary: describeSync(result), totals };
  }

  /** Once per dry run, and only if no later sync touched the job's groups. */
  private assertFresh(run: JobRunEntity, job: JobEntity): void {
    if (run.appliedAt)
      throw new ConflictException(
        'This dry run was already applied; start a new dry run',
      );
    const changed = this.sqlite.db
      .prepare(
        'SELECT 1 FROM job_group WHERE job_id = ? AND updated_at > ? LIMIT 1',
      )
      .get(job.id, sqliteNow(run.startedAt ?? run.createdAt));
    if (changed)
      throw new ConflictException(
        "The job's albums changed after this dry run started; start a new dry run",
      );
  }
}

function toSyncItem(g: StoredProposal): GroupSyncItem {
  return {
    action: g.action,
    selected: g.selected,
    existingId: g.jobGroupId ?? undefined,
    adoptAlbumId: g.action === 'create' ? g.albumId : null,
    proposal:
      g.action === 'create' || g.action === 'update'
        ? {
            key: g.key,
            name: g.name,
            start: date(g.start),
            end: date(g.end),
            coreStart: date(g.coreStart),
            coreEnd: date(g.coreEnd),
            ongoing: g.ongoing,
            summary: withoutAdoption(g.summary),
            assetIds: g.assetIds,
          }
        : undefined,
  };
}

function withoutAdoption(summary: Record<string, unknown>) {
  const { adoptAlbumId, adoptAlbumName, ...rest } = summary;
  void adoptAlbumId;
  void adoptAlbumName;
  return rest;
}
