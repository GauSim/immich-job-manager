import { Injectable } from '@nestjs/common';
import { AssetIndexService } from '../asset-index/asset-index.service.js';
import type { RunLogger } from '../core/job-type.js';
import { MANAGED_DESCRIPTION } from '../groups/adoption.js';
import { GroupStore } from '../groups/group-store.js';
import { ImmichClient } from '../immich/immich.client.js';
import type {
  GroupAction,
  GroupAssetState,
  GroupStatus,
  JobEntity,
} from '../persistence/entities/index.js';

/** One group to sync, from a real run's reconcile or a reviewed dry run (apply). */
export interface GroupSyncItem {
  action: GroupAction;
  /** Apply: unticked groups are remembered as ignored. Real runs: always true. */
  selected: boolean;
  proposal?: {
    key: string;
    name: string;
    start: Date;
    end: Date;
    coreStart: Date;
    coreEnd: Date;
    ongoing: boolean;
    summary: Record<string, unknown>;
    assetIds: readonly string[];
  };
  /** Matched stored group (update / ignored / locked / orphaned / merged). */
  existingId?: string;
  /** `create`: adopt this existing album instead of creating one. */
  adoptAlbumId?: string | null;
}

export interface GroupSyncOptions {
  /** `mirror` also removes assets the job added that no longer belong (never for adopted albums). */
  mode: 'additive' | 'mirror';
  runId: string | null;
  /** The job's exclusion album members: never added. */
  excluded: ReadonlySet<string>;
  log: RunLogger;
  signal?: AbortSignal;
}

export interface GroupSyncResult {
  created: number;
  adopted: number;
  updated: number;
  renamed: number;
  ignored: number;
  orphaned: number;
  merged: number;
  /** Assets added / removed by the job. */
  added: number;
  removed: number;
  /** Assets the user removed from an album since the last sync (now excluded from that group). */
  removedByHand: number;
  /** Assets the user added by hand (kept, never removed). */
  addedByHand: number;
  /** Ids Immich refused (dropped from the index). */
  failed: number;
}

/** Description of albums the job creates (adoption skips albums with this prefix). */
export function groupAlbumDescription(job: JobEntity): string {
  return `${MANAGED_DESCRIPTION} – ${job.name}`;
}

/** `name`, or `name (2)`, `name (3)` … if taken. */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Album sync for group jobs (trip-albums SDD §7.3). Per group: read the
 * album back, detect manual edits (removed by hand → excluded, added by hand
 * → present, renamed → name locked), add missing assets, remove owned
 * non-members in mirror mode (never for adopted albums), rename while the
 * name is not locked. A sync without changes makes no write calls.
 */
@Injectable()
export class GroupAlbumSync {
  constructor(
    private readonly immich: ImmichClient,
    private readonly groups: GroupStore,
    private readonly index: AssetIndexService,
  ) {}

  async sync(
    job: JobEntity,
    items: readonly GroupSyncItem[],
    options: GroupSyncOptions,
  ): Promise<GroupSyncResult> {
    const { signal, log } = options;
    const result: GroupSyncResult = {
      created: 0,
      adopted: 0,
      updated: 0,
      renamed: 0,
      ignored: 0,
      orphaned: 0,
      merged: 0,
      added: 0,
      removed: 0,
      removedByHand: 0,
      addedByHand: 0,
      failed: 0,
    };
    const albums = await this.immich.listOwnedAlbums({ signal });
    const nameById = new Map(albums.map((a) => [a.id, a.name]));
    const names = new Set(albums.map((a) => a.name));
    const stored = new Map(
      this.groups.loadExisting(job.id).map((g) => [g.id, g]),
    );

    for (const item of items) {
      signal?.throwIfAborted();
      const existing = item.existingId
        ? stored.get(item.existingId)
        : undefined;
      const p = item.proposal;

      if (!item.selected) {
        // Apply: unticked in the review → never created by later runs.
        if (existing) this.groups.setStatus(existing.id, 'ignored');
        else if (p && item.action === 'create')
          this.groups.insertGroup({
            jobId: job.id,
            key: p.key,
            status: 'ignored',
            start: p.start,
            end: p.end,
            coreStart: p.coreStart,
            coreEnd: p.coreEnd,
            summary: p.summary,
            albumId: null,
            generatedName: p.name,
            nameLocked: false,
            adopted: false,
            runId: options.runId,
          });
        result.ignored++;
        continue;
      }

      switch (item.action) {
        case 'ignored':
        case 'locked':
          continue;
        case 'orphaned':
        case 'merged':
          if (existing && existing.status !== item.action)
            this.groups.setStatus(existing.id, item.action);
          result[item.action]++;
          continue;
      }
      if (!p) continue;
      const status: GroupStatus = p.ongoing ? 'ongoing' : 'active';

      if (item.action === 'update' && existing?.albumId) {
        const currentName = nameById.get(existing.albumId);
        if (currentName === undefined) {
          // The user deleted the album: respect it.
          this.groups.setStatus(existing.id, 'ignored');
          log.warn(
            `Album of "${existing.name}" no longer exists in Immich; the trip is now ignored (set it active to recreate it)`,
          );
          result.ignored++;
          continue;
        }
        const nameLocked = existing.nameLocked || currentName !== existing.name;
        const members = new Set(
          await this.immich.listAlbumMemberIds(existing.albumId, { signal }),
        );
        await this.syncAssets(
          existing.id,
          existing.albumId,
          p.assetIds,
          members,
          this.groups.groupAssets(existing.id),
          existing.adopted,
          options,
          result,
        );
        let generatedName = nameLocked ? existing.name : currentName;
        if (!nameLocked && p.name !== currentName) {
          names.delete(currentName);
          const newName = uniqueName(p.name, names);
          await this.immich.renameAlbum(existing.albumId, newName, { signal });
          names.add(newName);
          nameById.set(existing.albumId, newName);
          generatedName = newName;
          result.renamed++;
          log.info(`Renamed album "${currentName}" → "${newName}"`);
        }
        this.groups.updateGroup(existing.id, {
          key: p.key,
          status,
          start: p.start,
          end: p.end,
          coreStart: p.coreStart,
          coreEnd: p.coreEnd,
          summary: p.summary,
          albumId: existing.albumId,
          generatedName,
          nameLocked,
          adopted: existing.adopted,
        });
        result.updated++;
        continue;
      }

      // create (or update of a stored group without an album, e.g. ignored before apply)
      const adoptId =
        item.adoptAlbumId && nameById.has(item.adoptAlbumId)
          ? item.adoptAlbumId
          : null;
      let albumId: string;
      let albumName: string;
      let members: Set<string>;
      if (adoptId) {
        albumId = adoptId;
        albumName = nameById.get(adoptId)!;
        members = new Set(
          await this.immich.listAlbumMemberIds(adoptId, { signal }),
        );
        result.adopted++;
        log.info(`Adopted existing album "${albumName}" for "${p.name}"`);
      } else {
        albumName = uniqueName(p.name, names);
        albumId = (
          await this.immich.createAlbum(albumName, {
            description: groupAlbumDescription(job),
            signal,
          })
        ).id;
        names.add(albumName);
        nameById.set(albumId, albumName);
        members = new Set();
        result.created++;
      }
      const group = {
        key: p.key,
        status,
        start: p.start,
        end: p.end,
        coreStart: p.coreStart,
        coreEnd: p.coreEnd,
        summary: p.summary,
        albumId,
        generatedName: albumName,
        nameLocked: !!adoptId,
        adopted: !!adoptId,
      };
      let groupId: string;
      if (existing) {
        groupId = existing.id;
        this.groups.updateGroup(groupId, group);
      } else {
        groupId = this.groups.insertGroup({
          ...group,
          jobId: job.id,
          runId: options.runId,
        });
      }
      await this.syncAssets(
        groupId,
        albumId,
        p.assetIds,
        members,
        existing ? this.groups.groupAssets(groupId) : new Map(),
        !!adoptId,
        options,
        result,
      );
    }
    return result;
  }

  private async syncAssets(
    groupId: string,
    albumId: string,
    target: readonly string[],
    members: Set<string>,
    states: Map<string, GroupAssetState>,
    adopted: boolean,
    options: GroupSyncOptions,
    result: GroupSyncResult,
  ): Promise<void> {
    const changes = new Map<string, GroupAssetState | null>();
    const set = (id: string, state: GroupAssetState | null) => {
      changes.set(id, state);
      if (state === null) states.delete(id);
      else states.set(id, state);
    };

    // Manual edits since the last sync.
    for (const [id, state] of states) {
      if ((state === 'owned' || state === 'present') && !members.has(id)) {
        set(id, 'excluded');
        result.removedByHand++;
      }
    }
    for (const id of members) {
      if (!states.has(id)) {
        set(id, 'present');
        result.addedByHand++;
      }
    }

    const wanted = new Set(target);
    const toAdd = [...wanted].filter(
      (id) =>
        !members.has(id) &&
        states.get(id) !== 'excluded' &&
        !options.excluded.has(id),
    );
    if (toAdd.length) {
      const res = await this.immich.addToAlbum(albumId, toAdd, {
        signal: options.signal,
      });
      for (const id of res.succeeded) {
        set(id, 'owned');
        members.add(id);
      }
      for (const id of res.unchanged) set(id, 'present');
      result.added += res.succeeded.length;
      this.refused(res.failed, result, options.log);
    }

    if (options.mode === 'mirror' && !adopted) {
      const toRemove = [...states]
        .filter(
          ([id, s]) => s === 'owned' && !wanted.has(id) && members.has(id),
        )
        .map(([id]) => id);
      if (toRemove.length) {
        const res = await this.immich.removeFromAlbum(albumId, toRemove, {
          signal: options.signal,
        });
        for (const id of [...res.succeeded, ...res.unchanged]) {
          set(id, null);
          members.delete(id);
        }
        result.removed += res.succeeded.length;
        this.refused(res.failed, result, options.log);
      }
    }

    this.groups.setGroupAssets(groupId, changes, options.runId);
  }

  private refused(
    failed: { id: string; error: string }[],
    result: GroupSyncResult,
    log: RunLogger,
  ): void {
    if (failed.length === 0) return;
    result.failed += failed.length;
    // Usually assets deleted in Immich since the last index refresh.
    this.index.forget(failed.map((f) => f.id));
    for (const f of failed.slice(0, 3))
      log.warn(`Immich refused ${f.id} (${f.error})`);
  }
}
