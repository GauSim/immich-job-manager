import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { JobTypeRegistry } from '../core/job-type.registry.js';
import type { JobEntity, RunTrigger } from '../persistence/entities/index.js';
import { SqliteService, sqliteNow } from '../persistence/sqlite.service.js';
import { JobLocks } from '../sync/job-locks.js';
import { RunQueue } from './run-queue.js';

export interface LaunchOptions {
  /** Default: true when the job's sync mode is `dry-run`. */
  dryRun?: boolean;
  /** Force a full scan even if an incremental run is possible. */
  fullRescan?: boolean;
  trigger: RunTrigger;
}

export interface RunPlan {
  dryRun: boolean;
  /** true → scan the whole library; false → only assets updated after `since`. */
  full: boolean;
  /** SQLite datetime of the last successful real run's start (incremental runs). */
  since: string | null;
  reason: string;
}

/**
 * Creates and queues runs (API and scheduler). Decides full vs. incremental
 * (SDD §3): real runs are incremental since the start of the last successful
 * real run, unless forced, never run before, or the job type's version changed.
 * Dry runs always scan everything (the review needs all candidates).
 */
@Injectable()
export class RunLauncher {
  constructor(
    private readonly sqlite: SqliteService,
    private readonly registry: JobTypeRegistry,
    private readonly queue: RunQueue,
    private readonly locks: JobLocks,
  ) {}

  plan(job: JobEntity, options: Omit<LaunchOptions, 'trigger'>): RunPlan {
    const dryRun = options.dryRun ?? job.syncMode === 'dry-run';
    if (dryRun)
      return {
        dryRun,
        full: true,
        since: null,
        reason: 'dry runs always scan the whole library',
      };
    if (options.fullRescan)
      return {
        dryRun,
        full: true,
        since: null,
        reason: 'full rescan requested',
      };
    const version = this.registry.has(job.typeId)
      ? this.registry.get(job.typeId).version
      : job.typeVersion;
    if (job.typeVersion !== version) {
      return {
        dryRun,
        full: true,
        since: null,
        reason: `job type changed (v${job.typeVersion} → v${version})`,
      };
    }
    const last = this.sqlite.db
      .prepare(
        `SELECT started_at FROM job_run WHERE job_id = ? AND dry_run = 0 AND status = 'succeeded'
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(job.id) as { started_at: string } | undefined;
    if (!last)
      return { dryRun, full: true, since: null, reason: 'first real run' };
    return {
      dryRun,
      full: false,
      since: last.started_at,
      reason: 'incremental',
    };
  }

  /** Creates a queued run; 409 if the job already has an active run or is being applied. */
  launch(
    job: JobEntity,
    options: LaunchOptions,
  ): { runId: string; plan: RunPlan } {
    const plan = this.plan(job, options);
    if (!plan.dryRun && job.syncMode === 'dry-run') {
      throw new BadRequestException(
        'The job is in dry-run mode; change its sync mode to run it for real',
      );
    }
    if (this.locks.isLocked(job.id)) {
      throw new ConflictException(
        'A dry run of this job is being applied; try again in a moment',
      );
    }
    const id = randomUUID();
    // One statement: no second active run per job, even with concurrent requests.
    const { changes } = this.sqlite.db
      .prepare(
        `INSERT INTO job_run (id, job_id, status, "trigger", dry_run, full_rescan, since, created_at)
         SELECT ?, ?, 'queued', ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM job_run WHERE job_id = ? AND status IN ('queued', 'running'))`,
      )
      .run(
        id,
        job.id,
        options.trigger,
        plan.dryRun ? 1 : 0,
        plan.full ? 1 : 0,
        plan.since,
        sqliteNow(),
        job.id,
      );
    if (changes === 0)
      throw new ConflictException(
        'The job already has a queued or running run',
      );
    this.queue.enqueue(id, job.id);
    return { runId: id, plan };
  }
}
