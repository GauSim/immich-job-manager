import { Injectable } from '@nestjs/common';
import { AssetIndexService } from '../asset-index/asset-index.service.js';
import type { AssetIndexReader } from '../asset-index/asset-index.reader.js';
import type {
  GroupJobType,
  ProposedGroup,
  RunLogger,
} from '../core/job-type.js';
import { findAdoptions, type Adoption } from '../groups/adoption.js';
import { RunEventsService } from '../events/run-events.service.js';
import {
  reconcileGroups,
  type ReconcileItem,
} from '../groups/group-reconciler.js';
import { GroupStore } from '../groups/group-store.js';
import { ImmichClient } from '../immich/immich.client.js';
import type {
  GroupAction,
  JobEntity,
  JobRunEntity,
} from '../persistence/entities/index.js';
import { exclusionAlbumName } from '../sync/album-sync.service.js';
import {
  GroupAlbumSync,
  type GroupSyncItem,
  type GroupSyncResult,
} from '../sync/group-album-sync.js';
import { RunStore, type RunTotals } from './run-store.js';

/** Cursor value once a group run's index refresh is complete (resume skips it). */
export const INDEX_DONE = 'index:done';

export interface GroupRunArgs {
  run: JobRunEntity;
  job: JobEntity;
  type: GroupJobType;
  params: unknown;
  /** The run's start; stored on index rows so a resumed refresh keeps earlier pages. */
  startedAt: Date;
  log: RunLogger;
  signal: AbortSignal;
}

/**
 * One run of a group job (trip-albums SDD §3.2): refresh the asset index
 * (resumable page by page) → group (pure, job type) → reconcile with the
 * stored groups → dry run: store the proposals for review; real run: sync
 * every group's album (GroupAlbumSync).
 */
@Injectable()
export class GroupRunExecutor {
  constructor(
    private readonly immich: ImmichClient,
    private readonly index: AssetIndexService,
    private readonly groups: GroupStore,
    private readonly store: RunStore,
    private readonly events: RunEventsService,
    private readonly albums: GroupAlbumSync,
  ) {}

  async execute(args: GroupRunArgs): Promise<RunTotals> {
    const { run, job, type, params, startedAt, log, signal } = args;
    const ownerId = await this.immich.getMyUserId({ signal });

    if (run.cursor !== INDEX_DONE) {
      log.info(
        run.cursor
          ? 'Resuming the asset index refresh'
          : 'Refreshing the asset index (whole library)',
      );
      for await (const page of this.index.refresh({
        startedAt,
        resumeFrom: run.cursor ?? undefined,
        signal,
      })) {
        signal.throwIfAborted();
        this.events.progress(
          run.id,
          this.store.persistIndexPage(run.id, page.scanned, page.cursor),
        );
      }
      const removed = this.index.completeRefresh(startedAt);
      this.store.setCursor(run.id, INDEX_DONE);
      log.info(
        `Index: ${this.index.count()} assets` +
          (removed ? `; ${removed} no longer in Immich were removed` : ''),
      );
    } else {
      log.info('Asset index already refreshed by this run');
    }

    // Exclusion album: only read here; real runs create it right before syncing (after the guardrail).
    const exclusionName = exclusionAlbumName(job);
    const exclusion = await this.immich.findAlbum(exclusionName, { signal });
    const excluded = new Set(
      exclusion
        ? await this.immich.listAlbumMemberIds(exclusion.id, { signal })
        : [],
    );
    log.info(
      `Exclusion album "${exclusionName}": ${exclusion ? `${excluded.size} assets` : 'does not exist yet'}`,
    );

    signal.throwIfAborted();
    const reader = this.index.read(type.indexFilter(params, ownerId));
    const proposed = (
      await type.group({
        params,
        index: reader,
        ownerId,
        now: new Date(),
        log,
        signal,
      })
    ).map((g) => ({
      ...g,
      assets: g.assets.filter((a) => !excluded.has(a.assetId)),
    }));

    const items = reconcileGroups(proposed, this.groups.loadExisting(job.id));
    const adoptions = await this.adoptions(type, params, items, reader, signal);
    const counts = new Map<GroupAction, number>();
    for (const i of items)
      counts.set(i.action, (counts.get(i.action) ?? 0) + 1);
    log.info(
      `${proposed.length} groups found` +
        (counts.size
          ? `: ${[...counts].map(([a, n]) => `${n} ${a}`).join(', ')}`
          : '') +
        (adoptions.size ? `; ${adoptions.size} existing albums to adopt` : ''),
    );

    if (run.dryRun) {
      const fileNames = new Map(reader.all().map((a) => [a.id, a.fileName]));
      const matched = this.groups.storeDryRun(
        run.id,
        items,
        fileNames,
        adoptions,
      );
      const totals = this.store.setMatched(run.id, matched);
      this.events.progress(run.id, totals);
      log.info(`${matched} assets in groups to create or update`);
      return totals;
    }

    // First real run without a review: refuse to create a flood of albums (SDD §7.5).
    const creates = (counts.get('create') ?? 0) - adoptions.size;
    if (
      !this.groups.hasGroups(job.id) &&
      creates > MAX_NEW_GROUPS_WITHOUT_REVIEW
    )
      throw new Error(
        `This first run would create ${creates} albums (more than ${MAX_NEW_GROUPS_WITHOUT_REVIEW}). ` +
          'Start a dry run, review the groups and apply it first.',
      );

    if (!exclusion)
      await this.immich.findOrCreateAlbum(exclusionName, {
        signal,
        description: `Assets in this album are kept out of the albums of "${job.name}" by Immich Album Jobs`,
      });

    const syncItems: GroupSyncItem[] = items.map((i) => ({
      action: i.action,
      selected: true,
      existingId: i.existing?.id,
      adoptAlbumId:
        i.action === 'create' && i.proposed
          ? (adoptions.get(i.proposed.key)?.albumId ?? null)
          : null,
      proposal: i.proposed && toSyncProposal(i.proposed),
    }));
    const result = await this.albums.sync(job, syncItems, {
      mode: job.syncMode === 'mirror' ? 'mirror' : 'additive',
      runId: run.id,
      excluded,
      log,
      signal,
    });
    const matched = items
      .filter((i) => i.action === 'create' || i.action === 'update')
      .reduce((n, i) => n + (i.proposed?.assets.length ?? 0), 0);
    this.store.setMatched(run.id, matched);
    const totals = this.store.addSyncTotals(
      run.id,
      result.added,
      result.removed,
    );
    this.events.progress(run.id, totals);
    log.info(describeSync(result));
    return totals;
  }

  /** Existing albums to adopt for new groups (read-only). */
  private async adoptions(
    type: GroupJobType,
    params: unknown,
    items: readonly ReconcileItem[],
    reader: AssetIndexReader,
    signal: AbortSignal,
  ): Promise<Map<string, Adoption>> {
    const options = type.adoption?.(params);
    const creates = items.filter((i) => i.action === 'create' && i.proposed);
    if (!options || creates.length === 0) return new Map();
    const takenAt = new Map(reader.all().map((a) => [a.id, a.takenAt]));
    return findAdoptions(
      creates.map((i) => ({
        key: i.proposed!.key,
        start: i.proposed!.start,
        end: i.proposed!.end,
        assetIds: i.proposed!.assets.map((a) => a.assetId),
      })),
      await this.immich.listOwnedAlbums({ signal }),
      this.groups.managedAlbumIds(),
      (id) => this.immich.listAlbumMemberIds(id, { signal }),
      (id) => takenAt.get(id),
      options,
    );
  }
}

/** First real run of a group job: at most this many new albums without a reviewed dry run. */
export const MAX_NEW_GROUPS_WITHOUT_REVIEW = 30;

export function toSyncProposal(
  p: ProposedGroup,
): NonNullable<GroupSyncItem['proposal']> {
  return {
    key: p.key,
    name: p.name,
    start: p.start,
    end: p.end,
    coreStart: p.coreStart,
    coreEnd: p.coreEnd,
    ongoing: p.ongoing,
    summary: p.summary,
    assetIds: p.assets.map((a) => a.assetId),
  };
}

export function describeSync(r: GroupSyncResult): string {
  const parts = [
    r.created && `${r.created} albums created`,
    r.adopted && `${r.adopted} adopted`,
    r.updated && `${r.updated} updated`,
    r.renamed && `${r.renamed} renamed`,
    r.ignored && `${r.ignored} ignored`,
    r.orphaned && `${r.orphaned} no longer detected`,
    r.merged && `${r.merged} merged`,
    `${r.added} assets added`,
    r.removed && `${r.removed} removed`,
    r.removedByHand && `${r.removedByHand} removed by hand (kept out)`,
    r.addedByHand && `${r.addedByHand} added by hand (kept)`,
    r.failed && `${r.failed} refused by Immich`,
  ].filter(Boolean);
  return `Album sync: ${parts.join(', ')}`;
}
