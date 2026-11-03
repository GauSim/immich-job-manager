import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, type Repository } from 'typeorm';
import { isGroupJobType } from '../core/job-type.js';
import { JobTypeRegistry } from '../core/job-type.registry.js';
import { JobScheduler } from '../scheduler/job-scheduler.js';
import {
  defaultExclusionAlbumName,
  exclusionAlbumName,
} from '../sync/album-sync.service.js';

export { defaultExclusionAlbumName };
import { JobEntity, JobRunEntity } from '../persistence/entities/index.js';
import { CreateJobDto, type UpdateJobDto } from './dto.js';
import {
  ValidationFailedException,
  zodErrors,
  type FieldError,
} from './validation.js';

export const ACTIVE_STATUSES = ['queued', 'running'] as const;

export interface JobView extends JobEntity {
  /** `groups`: one album per group (e.g. trip albums), no target album. */
  typeKind: 'assets' | 'groups';
  /** Effective exclusion album name (default applied). */
  effectiveExclusionAlbumName: string;
  lastRun: JobRunEntity | null;
  /** Next scheduled run (enabled jobs with a schedule), else null. */
  nextRunAt: Date | null;
}

@Injectable()
export class JobsService {
  constructor(
    @InjectRepository(JobEntity) private readonly jobs: Repository<JobEntity>,
    @InjectRepository(JobRunEntity)
    private readonly runs: Repository<JobRunEntity>,
    private readonly registry: JobTypeRegistry,
    private readonly scheduler: JobScheduler,
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
    const groupJob = isGroupJobType(this.registry.get(dto.typeId));
    if (!groupJob && !dto.targetAlbumName)
      throw new ValidationFailedException([
        { path: ['targetAlbumName'], message: 'is required' },
      ]);
    // Group jobs create one album per group; they have no target album.
    const targetAlbumName = groupJob ? '' : dto.targetAlbumName!;
    assertDistinctAlbums(
      targetAlbumName,
      dto.exclusionAlbumName ?? null,
      dto.name,
    );
    assertScheduleUsable(dto.enabled, dto.schedule ?? null);
    const { identifiers } = await this.jobs.insert({
      name: dto.name,
      typeId: dto.typeId,
      typeVersion: 0,
      params,
      targetAlbumName,
      exclusionAlbumName: dto.exclusionAlbumName ?? null,
      syncMode: dto.syncMode,
      schedule: dto.schedule ?? null,
      enabled: dto.enabled,
    });
    const id = identifiers[0].id as string;
    this.scheduler.sync(await this.getEntity(id));
    return this.get(id);
  }

  async update(id: string, dto: UpdateJobDto): Promise<JobView> {
    const job = await this.getEntity(id);
    const groupJob =
      this.registry.has(job.typeId) &&
      isGroupJobType(this.registry.get(job.typeId));
    if (groupJob && dto.targetAlbumName)
      throw new ValidationFailedException([
        {
          path: ['targetAlbumName'],
          message:
            'group jobs create one album per group; they have no target album',
        },
      ]);
    assertDistinctAlbums(
      dto.targetAlbumName ?? job.targetAlbumName,
      dto.exclusionAlbumName !== undefined
        ? dto.exclusionAlbumName
        : job.exclusionAlbumName,
      dto.name ?? job.name,
    );
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
    assertScheduleUsable(
      dto.enabled ?? job.enabled,
      dto.schedule !== undefined ? dto.schedule : job.schedule,
    );
    if (Object.keys(patch).length > 0) {
      await this.jobs.update(id, patch);
      this.scheduler.sync(await this.getEntity(id));
    }
    return this.get(id);
  }

  async exportAll(): Promise<{
    app: 'immich-album-jobs';
    version: 1;
    exportedAt: string;
    jobs: ExportedJob[];
  }> {
    const jobs = await this.jobs.find({ order: { name: 'ASC' } });
    return {
      app: 'immich-album-jobs',
      version: 1,
      exportedAt: new Date().toISOString(),
      jobs: jobs.map((j) => ({
        name: j.name,
        typeId: j.typeId,
        params: j.params,
        // Group jobs have no target album; omitted so the export re-imports.
        ...(j.targetAlbumName ? { targetAlbumName: j.targetAlbumName } : {}),
        exclusionAlbumName: j.exclusionAlbumName,
        syncMode: j.syncMode,
        schedule: j.schedule,
        enabled: j.enabled,
      })),
    };
  }

  /** Creates the given jobs (validated like `POST /jobs`); existing names are skipped. */
  async importAll(items: unknown[]): Promise<ImportResult> {
    const result: ImportResult = { created: [], skipped: [], failed: [] };
    const existing = new Set(
      (await this.jobs.find()).map((j) => j.name.toLowerCase()),
    );
    for (const [index, item] of items.entries()) {
      const name = (item as { name?: unknown } | null)?.name;
      const parsed = CreateJobDto.safeParse(item);
      if (!parsed.success) {
        result.failed.push({
          index,
          name: typeof name === 'string' ? name : undefined,
          errors: zodErrors(parsed.error),
        });
        continue;
      }
      if (existing.has(parsed.data.name.toLowerCase())) {
        result.skipped.push(parsed.data.name);
        continue;
      }
      try {
        await this.create(parsed.data);
        existing.add(parsed.data.name.toLowerCase());
        result.created.push(parsed.data.name);
      } catch (e) {
        const errors =
          e instanceof ValidationFailedException
            ? (e.getResponse() as { errors: FieldError[] }).errors
            : [{ path: [], message: (e as Error).message }];
        result.failed.push({ index, name: parsed.data.name, errors });
      }
    }
    return result;
  }

  /** Deletes the job and its run history. Never touches Immich albums. */
  async delete(id: string): Promise<void> {
    await this.getEntity(id);
    if (await this.isBusy(id))
      throw new ConflictException(
        'The job has a queued or running run; cancel it first',
      );
    await this.jobs.delete(id);
    this.scheduler.remove(id);
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
      effectiveExclusionAlbumName: exclusionAlbumName(job),
      typeKind:
        this.registry.has(job.typeId) &&
        isGroupJobType(this.registry.get(job.typeId))
          ? 'groups'
          : 'assets',
      lastRun,
      nextRunAt: this.scheduler.nextRun(job.id),
    }) as JobView;
  }
}

/** The exclusion album must not be the target album (it would exclude everything). */
function assertDistinctAlbums(
  target: string,
  exclusion: string | null,
  jobName: string,
): void {
  if (!target) return; // group jobs have no target album
  const effective = exclusionAlbumName({
    targetAlbumName: target,
    exclusionAlbumName: exclusion,
    name: jobName,
  });
  if (effective.trim().toLowerCase() === target.trim().toLowerCase()) {
    throw new ValidationFailedException([
      {
        path: ['exclusionAlbumName'],
        message: 'must differ from the target album',
      },
    ]);
  }
}

/** An enabled schedule needs a cron expression. */
function assertScheduleUsable(enabled: boolean, schedule: string | null): void {
  if (enabled && !schedule) {
    throw new ValidationFailedException([
      {
        path: ['schedule'],
        message: 'is required when the schedule is enabled',
      },
    ]);
  }
}

/** Portable job definition (export/import): no ids, albums by name. */
export interface ExportedJob {
  name: string;
  typeId: string;
  params: Record<string, unknown>;
  /** Omitted for group jobs. */
  targetAlbumName?: string;
  exclusionAlbumName: string | null;
  syncMode: JobEntity['syncMode'];
  schedule: string | null;
  enabled: boolean;
}

export interface ImportResult {
  created: string[];
  /** Skipped because a job with the same name exists. */
  skipped: string[];
  failed: { index: number; name?: string; errors: FieldError[] }[];
}
