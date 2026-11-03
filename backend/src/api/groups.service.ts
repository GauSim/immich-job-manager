import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AssetIndexService } from '../asset-index/asset-index.service.js';
import { isGroupJobType } from '../core/job-type.js';
import { JobTypeRegistry } from '../core/job-type.registry.js';
import {
  GroupStore,
  type JobGroupView,
  type RunGroupView,
} from '../groups/group-store.js';
import { ImmichClient } from '../immich/immich.client.js';
import type { GroupAction } from '../persistence/entities/index.js';
import type { UpdateJobGroupDto, UpdateRunGroupsDto } from './dto.js';
import { JobsService } from './jobs.service.js';
import { RunsService } from './runs.service.js';

export interface RunGroupsResponse {
  items: RunGroupView[];
  /** Groups per action, and how many are ticked. */
  summary: Record<GroupAction, number> & { selected: number };
}

/** API for group jobs: a dry run's proposed groups, a job's stored groups, insights. */
@Injectable()
export class GroupsService {
  constructor(
    private readonly groups: GroupStore,
    private readonly runs: RunsService,
    private readonly jobs: JobsService,
    private readonly registry: JobTypeRegistry,
    private readonly index: AssetIndexService,
    private readonly immich: ImmichClient,
  ) {}

  async runGroups(runId: string): Promise<RunGroupsResponse> {
    await this.runs.get(runId);
    const items = this.groups.listRunGroups(runId);
    const summary = {
      create: 0,
      update: 0,
      ignored: 0,
      locked: 0,
      orphaned: 0,
      merged: 0,
      selected: 0,
    };
    for (const g of items) {
      summary[g.action]++;
      if (g.selected) summary.selected++;
    }
    return { items, summary };
  }

  async selectRunGroups(
    runId: string,
    dto: UpdateRunGroupsDto,
  ): Promise<RunGroupsResponse & { updated: number }> {
    const run = await this.runs.get(runId);
    if (!run.dryRun)
      throw new ConflictException('Only dry runs have groups to review');
    if (run.status === 'queued' || run.status === 'running')
      throw new ConflictException('The dry run has not finished yet');
    const updated = this.groups.selectRunGroups(runId, dto.selected, dto.keys);
    return { ...(await this.runGroups(runId)), updated };
  }

  async jobGroups(jobId: string): Promise<JobGroupView[]> {
    await this.jobs.getEntity(jobId);
    return this.groups.listJobGroups(jobId);
  }

  async updateJobGroup(
    jobId: string,
    groupId: string,
    dto: UpdateJobGroupDto,
  ): Promise<JobGroupView> {
    await this.jobs.getEntity(jobId);
    return this.groups.setJobGroupStatus(jobId, groupId, dto.status);
  }

  /** Type-specific insights over the current index (trip albums: home per month). */
  async insights(jobId: string): Promise<unknown> {
    const job = await this.jobs.getEntity(jobId);
    const type = this.registry.has(job.typeId)
      ? this.registry.get(job.typeId)
      : undefined;
    if (!type || !isGroupJobType(type) || !type.insights)
      throw new NotFoundException('This job type has no insights');
    const parsed = type.params.safeParse(job.params);
    if (!parsed.success)
      throw new ConflictException('The job has invalid params');
    const ownerId = await this.immich.getMyUserId();
    return type.insights({
      params: parsed.data,
      index: this.index.read(type.indexFilter(parsed.data, ownerId)),
      ownerId,
      now: new Date(),
    });
  }
}
