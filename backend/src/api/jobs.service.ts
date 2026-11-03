import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, type Repository } from 'typeorm';
import { JobTypeRegistry } from '../core/job-type.registry.js';
import { JobEntity, JobRunEntity } from '../persistence/entities/index.js';
import type { CreateJobDto, UpdateJobDto } from './dto.js';
import { ValidationFailedException, zodErrors } from './validation.js';

export const ACTIVE_STATUSES = ['queued', 'running'] as const;

export function defaultExclusionAlbumName(target: string): string {
  return `${target} – excluded`;
}

export interface JobView extends JobEntity {
  /** Effective exclusion album name (default applied). */
  effectiveExclusionAlbumName: string;
  lastRun: JobRunEntity | null;
}

@Injectable()
export class JobsService {
  constructor(
    @InjectRepository(JobEntity) private readonly jobs: Repository<JobEntity>,
    @InjectRepository(JobRunEntity)
    private readonly runs: Repository<JobRunEntity>,
    private readonly registry: JobTypeRegistry,
  ) {}

  async list(): Promise<JobView[]> {
    const jobs = await this.jobs.find({ order: { name: 'ASC' } });
    const lastRuns = await this.lastRuns(jobs.map((j) => j.id));
    return jobs.map((j) => this.view(j, lastRuns.get(j.id) ?? null));
  }

  async get(id: string): Promise<JobView> {
    const job = await this.getEntity(id);
    return this.view(job, (await this.lastRuns([id])).get(id) ?? null);
  }

  async getEntity(id: string): Promise<JobEntity> {
    const job = await this.jobs.findOneBy({ id });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    return job;
  }

  async create(dto: CreateJobDto): Promise<JobView> {
    if (!this.registry.has(dto.typeId)) {
      throw new ValidationFailedException([
        { path: ['typeId'], message: `unknown job type "${dto.typeId}"` },
      ]);
    }
    const params = this.parseParams(dto.typeId, dto.params);
    const { identifiers } = await this.jobs.insert({
      name: dto.name,
      typeId: dto.typeId,
      typeVersion: 0,
      params,
      targetAlbumName: dto.targetAlbumName,
      exclusionAlbumName: dto.exclusionAlbumName ?? null,
      syncMode: dto.syncMode,
      schedule: dto.schedule ?? null,
      enabled: dto.enabled,
    });
    return this.get(identifiers[0].id as string);
  }

  async update(id: string, dto: UpdateJobDto): Promise<JobView> {
    const job = await this.getEntity(id);
    const patch: Partial<JobEntity> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (
      dto.targetAlbumName !== undefined &&
      dto.targetAlbumName !== job.targetAlbumName
    ) {
      patch.targetAlbumName = dto.targetAlbumName;
      patch.targetAlbumId = null; // re-resolved on the next run
    }
    if (
      dto.exclusionAlbumName !== undefined &&
      dto.exclusionAlbumName !== job.exclusionAlbumName
    ) {
      patch.exclusionAlbumName = dto.exclusionAlbumName ?? null;
      patch.exclusionAlbumId = null;
    }
    if (dto.params !== undefined)
      patch.params = this.parseParams(job.typeId, dto.params);
    if (dto.syncMode !== undefined) patch.syncMode = dto.syncMode;
    if (dto.schedule !== undefined) patch.schedule = dto.schedule ?? null;
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (Object.keys(patch).length > 0) await this.jobs.update(id, patch);
    return this.get(id);
  }

  /** Deletes the job and its run history. Never touches Immich albums. */
  async delete(id: string): Promise<void> {
    await this.getEntity(id);
    if (await this.isBusy(id))
      throw new ConflictException(
        'The job has a queued or running run; cancel it first',
      );
    await this.jobs.delete(id);
  }

  isBusy(jobId: string): Promise<boolean> {
    return this.runs.existsBy({ jobId, status: In([...ACTIVE_STATUSES]) });
  }

  private parseParams(typeId: string, params: unknown): JobEntity['params'] {
    const result = this.registry.parseParams(typeId, params);
    if (!result.success)
      throw new ValidationFailedException(zodErrors(result.error, ['params']));
    return result.data as JobEntity['params'];
  }

  private async lastRuns(jobIds: string[]): Promise<Map<string, JobRunEntity>> {
    if (jobIds.length === 0) return new Map();
    const rows = await this.runs
      .createQueryBuilder('r')
      .where('r.job_id IN (:...jobIds)', { jobIds })
      .andWhere(
        'r.created_at = (SELECT MAX(r2.created_at) FROM job_run r2 WHERE r2.job_id = r.job_id)',
      )
      .getMany();
    return new Map(rows.map((r) => [r.jobId, r]));
  }

  private view(job: JobEntity, lastRun: JobRunEntity | null): JobView {
    return Object.assign(Object.create(null) as object, job, {
      effectiveExclusionAlbumName:
        job.exclusionAlbumName ??
        defaultExclusionAlbumName(job.targetAlbumName),
      lastRun,
    }) as JobView;
  }
}
