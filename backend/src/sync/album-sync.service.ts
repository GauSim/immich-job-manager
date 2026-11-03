import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { ImmichClient } from '../immich/immich.client.js';
import { JobEntity } from '../persistence/entities/index.js';

/** `Screenshots` → `Screenshots – excluded` */
export function defaultExclusionAlbumName(target: string): string {
  return `${target} – excluded`;
}

/**
 * Effective exclusion album. Group jobs (e.g. trip albums) have no target
 * album; their default is `<job name> – excluded`.
 */
export function exclusionAlbumName(
  job: Pick<JobEntity, 'targetAlbumName' | 'exclusionAlbumName'> &
    Partial<Pick<JobEntity, 'name'>>,
): string {
  return (
    job.exclusionAlbumName ??
    defaultExclusionAlbumName(job.targetAlbumName || job.name || 'Album job')
  );
}

export interface AlbumRef {
  id: string;
  name: string;
  created?: boolean;
}

/** Album state for one sync session; `members` is kept up to date as assets are added. */
export interface SyncTargets {
  /** null only when not creating (dry runs, previews) and the album does not exist yet. */
  target: AlbumRef | null;
  exclusion: AlbumRef | null;
  targetName: string;
  exclusionName: string;
  members: Set<string>;
  excluded: Set<string>;
}

export interface AddResult {
  /** Ids newly added to the album. */
  added: string[];
  /** Already in the album (skipped, or `duplicate` from Immich). */
  alreadyInAlbum: number;
  /** In the exclusion album (skipped). */
  excluded: number;
  /** Refused by Immich (e.g. `no_permission` for deleted assets). */
  failed: { id: string; error: string }[];
}

export interface RemovalResult {
  removed: string[];
  /** Owned ids that are no longer in the album (removed by hand): ownership is dropped. */
  forgotten: string[];
  failed: { id: string; error: string }[];
}

/**
 * Album sync (SDD §5.4): `toAdd = matches − members − excluded`,
 * mirror: `toRemove = owned − matches`. Idempotent: a rerun without library
 * changes makes no write calls. Only assets this app added (owned) are ever removed.
 */
@Injectable()
export class AlbumSyncService {
  constructor(
    private readonly immich: ImmichClient,
    @InjectRepository(JobEntity) private readonly jobs: Repository<JobEntity>,
  ) {}

  /**
   * Resolves the target and exclusion albums and loads their members.
   * `create: false` (dry runs, previews) never changes Immich.
   */
  async resolve(
    job: JobEntity,
    options: { create: boolean; signal?: AbortSignal },
  ): Promise<SyncTargets> {
    const { signal } = options;
    const targetName = job.targetAlbumName;
    const exclusionName = exclusionAlbumName(job);
    const target = options.create
      ? await this.immich.findOrCreateAlbum(targetName, {
          signal,
          description: 'Managed by Immich Album Jobs',
        })
      : await this.immich.findAlbum(targetName, { signal });
    const exclusion = options.create
      ? await this.immich.findOrCreateAlbum(exclusionName, {
          signal,
          description: `Assets in this album are kept out of "${targetName}" by Immich Album Jobs`,
        })
      : await this.immich.findAlbum(exclusionName, { signal });

    if (
      options.create &&
      target &&
      exclusion &&
      (job.targetAlbumId !== target.id || job.exclusionAlbumId !== exclusion.id)
    ) {
      await this.jobs.update(job.id, {
        targetAlbumId: target.id,
        exclusionAlbumId: exclusion.id,
      });
    }

    const [members, excluded] = await Promise.all([
      target
        ? this.immich.listAlbumMemberIds(target.id, { signal })
        : Promise.resolve([]),
      exclusion
        ? this.immich.listAlbumMemberIds(exclusion.id, { signal })
        : Promise.resolve([]),
    ]);
    return {
      target,
      exclusion,
      targetName,
      exclusionName,
      members: new Set(members),
      excluded: new Set(excluded),
    };
  }

  /** Adds the ids that are neither members nor excluded (chunks of 500). */
  async add(
    targets: SyncTargets,
    assetIds: string[],
    signal?: AbortSignal,
  ): Promise<AddResult> {
    let alreadyInAlbum = 0;
    let excluded = 0;
    const toAdd: string[] = [];
    for (const id of new Set(assetIds)) {
      if (targets.excluded.has(id)) excluded++;
      else if (targets.members.has(id)) alreadyInAlbum++;
      else toAdd.push(id);
    }
    if (toAdd.length === 0)
      return { added: [], alreadyInAlbum, excluded, failed: [] };
    if (!targets.target)
      throw new Error(
        `Album "${targets.targetName}" was not resolved for writing`,
      );

    const result = await this.immich.addToAlbum(targets.target.id, toAdd, {
      signal,
    });
    for (const id of [...result.succeeded, ...result.unchanged])
      targets.members.add(id);
    return {
      added: result.succeeded,
      alreadyInAlbum: alreadyInAlbum + result.unchanged.length,
      excluded,
      failed: result.failed,
    };
  }

  /** Mirror mode: removes owned assets that no longer match (chunks of 500). */
  async removeOwnedNonMatches(
    targets: SyncTargets,
    owned: string[],
    matches: Set<string>,
    signal?: AbortSignal,
  ): Promise<RemovalResult> {
    const toRemove: string[] = [];
    const forgotten: string[] = [];
    for (const id of owned) {
      if (matches.has(id)) continue;
      if (targets.members.has(id)) toRemove.push(id);
      else forgotten.push(id);
    }
    if (toRemove.length === 0 || !targets.target)
      return { removed: [], forgotten, failed: [] };
    const result = await this.immich.removeFromAlbum(
      targets.target.id,
      toRemove,
      { signal },
    );
    for (const id of [...result.succeeded, ...result.unchanged])
      targets.members.delete(id);
    return {
      removed: result.succeeded,
      forgotten: [...forgotten, ...result.unchanged],
      failed: result.failed,
    };
  }
}
