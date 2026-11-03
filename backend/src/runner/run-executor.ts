import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import type { JobContext } from '../core/job-type.js';
import { JobTypeRegistry } from '../core/job-type.registry.js';
import { RunEventsService } from '../events/run-events.service.js';
import { AlbumSyncService } from '../sync/album-sync.service.js';
import { ImmichClient } from '../immich/immich.client.js';
import {
  JobEntity,
  JobRunEntity,
  RunLogEntity,
  type RunStatus,
} from '../persistence/entities/index.js';
import { RunCancelledError, RunInterruptedError } from './run-errors.js';
import { DbRunLogger } from './run-logger.js';
import { RunStore, type RunTotals } from './run-store.js';

/**
 * Executes one run: pulls batches from the job type and persists each one
 * (candidates, totals, cursor) in a single transaction before asking for the
 * next. Never throws; the outcome is the run's final status.
 */
@Injectable()
export class RunExecutor {
  private readonly logger = new Logger(RunExecutor.name);

  constructor(
    @InjectRepository(JobRunEntity)
    private readonly runs: Repository<JobRunEntity>,
    @InjectRepository(JobEntity) private readonly jobs: Repository<JobEntity>,
    @InjectRepository(RunLogEntity)
    private readonly logs: Repository<RunLogEntity>,
    private readonly store: RunStore,
    private readonly registry: JobTypeRegistry,
    private readonly immich: ImmichClient,
    private readonly events: RunEventsService,
    private readonly albumSync: AlbumSyncService,
  ) {}

  async execute(runId: string, signal: AbortSignal): Promise<void> {
    const run = await this.runs.findOneBy({ id: runId });
    if (!run || run.status !== 'queued') {
      this.logger.warn(
        `Run ${runId} is not queued (${run?.status ?? 'missing'}); skipping`,
      );
      return;
    }
    const log = new DbRunLogger(runId, this.logs, this.events);
    const startedAt = run.startedAt ?? new Date();
    await this.runs.update(runId, {
      status: 'running',
      startedAt,
      finishedAt: null,
      error: null,
    });
    this.events.status(runId, 'running', null);

    let status: RunStatus = 'succeeded';
    let error: string | null = null;
    let totals: RunTotals | undefined;
    try {
      const job = await this.jobs.findOneBy({ id: run.jobId });
      if (!job) throw new Error('The job of this run no longer exists');
      const type = this.registry.get(job.typeId);
      const parsed = type.params.safeParse(job.params);
      if (!parsed.success)
        throw new Error(
          `Invalid job params: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );

      await this.immich.assertCompatible({ signal });

      const resumeFrom = run.cursor ?? undefined;
      const mode = run.dryRun ? 'dry run' : 'run';
      log.info(
        resumeFrom
          ? `Resuming ${mode} of "${job.name}" (${type.id} v${type.version})`
          : `Starting ${mode} of "${job.name}" (${type.id} v${type.version})`,
      );

      // Albums: dry runs only read (exclusions), real runs find or create them.
      const albums = await this.albumSync.resolve(job, {
        create: !run.dryRun,
        signal,
      });
      log.info(
        `Album "${albums.targetName}": ${albums.target ? `${albums.members.size} assets${albums.target.created ? ' (created)' : ''}` : 'does not exist yet'}; ` +
          `exclusion album "${albums.exclusionName}": ${albums.exclusion ? `${albums.excluded.size} assets${albums.exclusion.created ? ' (created)' : ''}` : 'does not exist yet'}`,
      );
      const mirror = !run.dryRun && job.syncMode === 'mirror';
      const matches = new Set<string>();
      const sync = { excluded: 0, alreadyInAlbum: 0, failed: 0 };

      const ctx: JobContext<unknown> = {
        runId,
        jobId: job.id,
        params: parsed.data,
        immich: this.immich,
        since: run.since ?? undefined,
        resumeFrom,
        dryRun: run.dryRun,
        log,
        signal,
      };

      for await (const batch of type.select(ctx)) {
        signal.throwIfAborted();
        // Excluded assets never count as matches (SDD §4.3).
        const candidates = batch.candidates.filter(
          (c) => !albums.excluded.has(c.assetId),
        );
        sync.excluded += batch.candidates.length - candidates.length;
        let owned: { jobId: string; assetIds: string[] } | undefined;
        if (!run.dryRun) {
          // Write this page's new matches before its cursor is saved, so a
          // resume can never skip unwritten matches.
          const ids = candidates.map((c) => c.assetId);
          if (mirror) for (const id of ids) matches.add(id);
          const result = await this.albumSync.add(albums, ids, signal);
          sync.alreadyInAlbum += result.alreadyInAlbum;
          sync.failed += result.failed.length;
          for (const f of result.failed.slice(0, 3)) {
            log.warn(`Immich refused to add ${f.id} (${f.error})`);
          }
          owned = { jobId: job.id, assetIds: result.added };
        }
        totals = this.store.persistPage(
          runId,
          { ...batch, candidates },
          { storeCandidates: run.dryRun, owned },
        );
        this.events.progress(runId, totals);
      }

      if (mirror) {
        if (resumeFrom) {
          log.warn(
            'Mirror mode: removals skipped because this run was resumed (matches of earlier pages are unknown). Run a full rescan to remove.',
          );
        } else if (run.since) {
          log.info('Mirror mode: removals only happen on full rescans');
        } else {
          const owned = this.store.ownedAssetIds(job.id);
          const removal = await this.albumSync.removeOwnedNonMatches(
            albums,
            owned,
            matches,
            signal,
          );
          totals = this.store.recordRemovals(
            runId,
            job.id,
            removal.removed,
            removal.forgotten,
          );
          sync.failed += removal.failed.length;
          if (removal.removed.length || removal.forgotten.length) {
            log.info(
              `Mirror mode: removed ${removal.removed.length} owned asset(s) that no longer match` +
                (removal.forgotten.length
                  ? `; ${removal.forgotten.length} were already removed by hand`
                  : ''),
            );
          }
          this.events.progress(runId, totals);
        }
      }

      log.info(
        `Finished: ${totals?.scanned ?? 0} scanned, ${totals?.matched ?? 0} matched` +
          (run.dryRun
            ? ''
            : `, ${totals?.added ?? 0} added, ${totals?.removed ?? 0} removed, ${sync.alreadyInAlbum} already in album`) +
          (sync.excluded ? `, ${sync.excluded} excluded` : '') +
          (sync.failed ? `, ${sync.failed} refused by Immich` : '') +
          ` in ${seconds(startedAt)} s`,
      );
    } catch (e) {
      const reason: unknown = signal.aborted ? signal.reason : undefined;
      if (reason instanceof RunCancelledError) {
        status = 'cancelled';
        log.warn('Cancelled');
      } else if (reason instanceof RunInterruptedError) {
        status = 'interrupted';
        error = reason.message;
        log.warn(
          `${reason.message}; resume continues from the last saved page`,
        );
      } else {
        status = 'failed';
        error = (e as Error)?.message ?? String(e);
        log.error(`Failed: ${error}`);
      }
    }

    await log.flush();
    await this.runs.update(runId, { status, error, finishedAt: new Date() });
    const final = await this.runs.findOneBy({ id: runId });
    this.events.status(runId, status, error, final ? totalsOf(final) : totals);
  }
}

export function totalsOf(run: JobRunEntity): RunTotals {
  return {
    scanned: run.scanned,
    matched: run.matched,
    added: run.added,
    removed: run.removed,
    filesRead: run.filesRead,
    cacheHits: run.cacheHits,
  };
}

function seconds(since: Date): string {
  return ((Date.now() - since.getTime()) / 1000).toFixed(1);
}
