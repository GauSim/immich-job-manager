import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, type Repository } from 'typeorm';
import { RunEventsService } from '../events/run-events.service.js';
import { JobRunEntity, RunLogEntity } from '../persistence/entities/index.js';
import { SqliteService, sqliteNow } from '../persistence/sqlite.service.js';
import { RunCancelledError } from '../runner/run-errors.js';
import { totalsOf } from '../runner/run-executor.js';
import { RunQueue } from '../runner/run-queue.js';
import { JobLocks } from '../sync/job-locks.js';
import type { LogQuery, PageQuery, StartRunDto } from './dto.js';
import { JobsService } from './jobs.service.js';

const ACTIVE_SQL = `status IN ('queued', 'running')`;

@Injectable()
export class RunsService {
  constructor(
    @InjectRepository(JobRunEntity)
    private readonly runs: Repository<JobRunEntity>,
    @InjectRepository(RunLogEntity)
    private readonly logRepo: Repository<RunLogEntity>,
    private readonly jobs: JobsService,
    private readonly queue: RunQueue,
    private readonly events: RunEventsService,
    private readonly sqlite: SqliteService,
    private readonly locks: JobLocks,
  ) {}

  async start(jobId: string, dto: StartRunDto): Promise<JobRunEntity> {
    const job = await this.jobs.getEntity(jobId);
    const dryRun = dto.dryRun ?? job.syncMode === 'dry-run';
    if (!dryRun && job.syncMode === 'dry-run') {
      throw new BadRequestException(
        'The job is in dry-run mode; change its sync mode to run it for real',
      );
    }
    if (this.locks.isLocked(jobId)) {
      throw new ConflictException(
        'A dry run of this job is being applied; try again in a moment',
      );
    }
    const id = randomUUID();
    // One statement: no second active run per job, even with concurrent requests.
    const { changes } = this.sqlite.db
      .prepare(
        `INSERT INTO job_run (id, job_id, status, "trigger", dry_run, full_rescan, created_at)
         SELECT ?, ?, 'queued', 'manual', ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM job_run WHERE job_id = ? AND ${ACTIVE_SQL})`,
      )
      .run(
        id,
        jobId,
        dryRun ? 1 : 0,
        dto.fullRescan ? 1 : 0,
        sqliteNow(),
        jobId,
      );
    if (changes === 0)
      throw new ConflictException(
        'The job already has a queued or running run',
      );
    this.queue.enqueue(id, jobId);
    return this.get(id);
  }

  async get(id: string): Promise<JobRunEntity> {
    const run = await this.runs.findOneBy({ id });
    if (!run) throw new NotFoundException(`Run ${id} not found`);
    return run;
  }

  async listForJob(
    jobId: string,
    page: PageQuery,
  ): Promise<{ items: JobRunEntity[]; total: number }> {
    await this.jobs.getEntity(jobId);
    const [items, total] = await this.runs.findAndCount({
      where: { jobId },
      order: { createdAt: 'DESC' },
      take: page.limit,
      skip: page.offset,
    });
    return { items, total };
  }

  async cancel(id: string): Promise<JobRunEntity> {
    const run = await this.get(id);
    if (run.status === 'queued') {
      this.queue.removeQueued(id);
      const res = await this.runs.update(
        { id, status: 'queued' },
        { status: 'cancelled', finishedAt: new Date() },
      );
      if (res.affected) {
        this.events.status(id, 'cancelled', null, totalsOf(run));
        return this.get(id);
      }
      // Started in the meantime: fall through and abort it.
    }
    if (this.queue.abort(id, new RunCancelledError())) return this.get(id);
    throw new ConflictException(
      `Run is ${run.status}; only queued or running runs can be cancelled`,
    );
  }

  async resume(id: string): Promise<JobRunEntity> {
    const run = await this.get(id);
    if (run.status !== 'interrupted' && run.status !== 'failed') {
      throw new ConflictException(
        `Run is ${run.status}; only interrupted or failed runs can be resumed`,
      );
    }
    const { changes } = this.sqlite.db
      .prepare(
        `UPDATE job_run SET status = 'queued', error = NULL, finished_at = NULL
         WHERE id = ? AND status IN ('interrupted', 'failed')
           AND NOT EXISTS (SELECT 1 FROM job_run WHERE job_id = ? AND ${ACTIVE_SQL})`,
      )
      .run(id, run.jobId);
    if (changes === 0)
      throw new ConflictException(
        'The job already has a queued or running run',
      );
    this.queue.enqueue(id, run.jobId);
    return this.get(id);
  }

  async logs(id: string, query: LogQuery): Promise<RunLogEntity[]> {
    await this.get(id);
    return this.logRepo.find({
      where: { runId: id, id: MoreThan(query.after) },
      order: { id: 'ASC' },
      take: query.limit,
    });
  }
}
