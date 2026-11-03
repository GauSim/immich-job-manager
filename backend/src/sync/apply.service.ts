import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, type Repository } from 'typeorm';
import { JobEntity, JobRunEntity } from '../persistence/entities/index.js';
import { RunStore, type RunTotals } from '../runner/run-store.js';
import { AlbumSyncService } from './album-sync.service.js';
import { JobLocks } from './job-locks.js';

export interface ApplyPreview {
  albumName: string;
  /** false → the album is created on apply. */
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
  totals: RunTotals;
}

/** `POST /runs/:id/apply`: adds a dry run's selected candidates to the job's album. Never removes. */
@Injectable()
export class ApplyService {
  private readonly logger = new Logger(ApplyService.name);

  constructor(
    @InjectRepository(JobRunEntity)
    private readonly runs: Repository<JobRunEntity>,
    @InjectRepository(JobEntity) private readonly jobs: Repository<JobEntity>,
    private readonly sync: AlbumSyncService,
    private readonly store: RunStore,
    private readonly locks: JobLocks,
  ) {}

  /** Counts for the confirmation dialog. Read-only: does not create albums. */
  async preview(runId: string): Promise<ApplyPreview> {
    const { run, job } = await this.load(runId);
    const targets = await this.sync.resolve(job, { create: false });
    const counts = { selected: 0, alreadyInAlbum: 0, excluded: 0, toAdd: 0 };
    for (const id of this.store.selectedCandidateIds(run.id)) {
      counts.selected++;
      if (targets.excluded.has(id)) counts.excluded++;
      else if (targets.members.has(id)) counts.alreadyInAlbum++;
      else counts.toAdd++;
    }
    return {
      albumName: targets.targetName,
      albumExists: !!targets.target,
      exclusionAlbumName: targets.exclusionName,
      ...counts,
    };
  }

  async apply(runId: string): Promise<ApplyResult> {
    const { run, job } = await this.load(runId);
    if (!this.locks.tryLock(job.id))
      throw new ConflictException('This job is already being applied');
    try {
      if (
        await this.runs.existsBy({
          jobId: job.id,
          status: In(['queued', 'running']),
        })
      ) {
        throw new ConflictException(
          'The job has a queued or running run; wait for it to finish',
        );
      }
      const selected = this.store.selectedCandidateIds(run.id);
      const targets = await this.sync.resolve(job, { create: true });
      const result = await this.sync.add(targets, selected);
      const totals = this.store.recordApply(run.id, job.id, result.added);
      if (result.failed.length) {
        this.logger.warn(
          `Apply of run ${run.id}: ${result.failed.length} asset(s) refused by Immich`,
        );
      }
      return {
        albumName: targets.targetName,
        albumCreated: !!targets.target?.created,
        selected: selected.length,
        added: result.added.length,
        alreadyInAlbum: result.alreadyInAlbum,
        excluded: result.excluded,
        failed: result.failed.length,
        totals,
      };
    } finally {
      this.locks.unlock(job.id);
    }
  }

  private async load(
    runId: string,
  ): Promise<{ run: JobRunEntity; job: JobEntity }> {
    const run = await this.runs.findOneBy({ id: runId });
    if (!run) throw new NotFoundException(`Run ${runId} not found`);
    if (!run.dryRun)
      throw new ConflictException('Only dry runs can be applied');
    if (run.status === 'queued' || run.status === 'running') {
      throw new ConflictException('The dry run has not finished yet');
    }
    const job = await this.jobs.findOneBy({ id: run.jobId });
    if (!job)
      throw new NotFoundException('The job of this run no longer exists');
    return { run, job };
  }
}
