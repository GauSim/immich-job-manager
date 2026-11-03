import { Injectable } from '@nestjs/common';
import { AssetIndexService } from '../asset-index/asset-index.service.js';
import type { GroupJobType, RunLogger } from '../core/job-type.js';
import { RunEventsService } from '../events/run-events.service.js';
import { reconcileGroups } from '../groups/group-reconciler.js';
import { GroupStore } from '../groups/group-store.js';
import { ImmichClient } from '../immich/immich.client.js';
import type {
  GroupAction,
  JobEntity,
  JobRunEntity,
} from '../persistence/entities/index.js';
import { exclusionAlbumName } from '../sync/album-sync.service.js';
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
 * stored groups → dry run: store the proposals for review. Real runs need
 * album sync, which comes with T4.
 */
@Injectable()
export class GroupRunExecutor {
  constructor(
    private readonly immich: ImmichClient,
    private readonly index: AssetIndexService,
    private readonly groups: GroupStore,
    private readonly store: RunStore,
    private readonly events: RunEventsService,
  ) {}

  async execute(args: GroupRunArgs): Promise<RunTotals> {
    const { run, job, type, params, startedAt, log, signal } = args;
    if (!run.dryRun)
      throw new Error(
        'Real runs of group jobs are not available yet (album sync comes in trip albums phase T4); start a dry run',
      );
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

    // Exclusion album: read only, like asset dry runs.
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
    const fileNames = new Map(reader.all().map((a) => [a.id, a.fileName]));
    const matched = this.groups.storeDryRun(run.id, items, fileNames);
    const totals = this.store.setMatched(run.id, matched);
    this.events.progress(run.id, totals);

    const counts = new Map<GroupAction, number>();
    for (const i of items)
      counts.set(i.action, (counts.get(i.action) ?? 0) + 1);
    log.info(
      `${proposed.length} groups found` +
        (counts.size
          ? `: ${[...counts].map(([a, n]) => `${n} ${a}`).join(', ')}`
          : '') +
        `; ${matched} assets`,
    );
    return totals;
  }
}
