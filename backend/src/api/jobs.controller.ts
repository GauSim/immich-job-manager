import {
  Body,
  Header,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  JobTypeRegistry,
  type JobTypeInfo,
} from '../core/job-type.registry.js';
import type { JobRunEntity } from '../persistence/entities/index.js';
import {
  CreateJobDto,
  ImportJobsDto,
  PageQuery,
  StartRunDto,
  UpdateJobDto,
  UpdateJobGroupDto,
} from './dto.js';
import { GroupsService } from './groups.service.js';
import type { JobGroupView } from '../groups/group-store.js';
import {
  JobsService,
  type ImportResult,
  type JobView,
} from './jobs.service.js';
import { RunsService } from './runs.service.js';
import { ZodPipe } from './validation.js';

@Controller('job-types')
export class JobTypesController {
  constructor(private readonly registry: JobTypeRegistry) {}

  @Get()
  list(): JobTypeInfo[] {
    return this.registry.list();
  }
}

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly runs: RunsService,
    private readonly groups: GroupsService,
  ) {}

  @Get()
  list(): Promise<JobView[]> {
    return this.jobs.list();
  }

  /** All job definitions as JSON (backup / move to another instance). Declared before `:id`. */
  @Get('export')
  @Header(
    'Content-Disposition',
    'attachment; filename="immich-album-jobs.json"',
  )
  exportJobs(): ReturnType<JobsService['exportAll']> {
    return this.jobs.exportAll();
  }

  @Post('import')
  @HttpCode(200)
  importJobs(
    @Body(new ZodPipe(ImportJobsDto)) dto: ImportJobsDto,
  ): Promise<ImportResult> {
    return this.jobs.importAll(dto.jobs);
  }

  @Post()
  create(@Body(new ZodPipe(CreateJobDto)) dto: CreateJobDto): Promise<JobView> {
    return this.jobs.create(dto);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<JobView> {
    return this.jobs.get(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(UpdateJobDto)) dto: UpdateJobDto,
  ): Promise<JobView> {
    return this.jobs.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.jobs.delete(id);
  }

  @Post(':id/runs')
  @HttpCode(202)
  startRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(StartRunDto)) dto: StartRunDto,
  ): Promise<JobRunEntity> {
    return this.runs.start(id, dto);
  }

  /** Group jobs: stored groups (e.g. trips) with their status and album. */
  @Get(':id/groups')
  listGroups(@Param('id', ParseUUIDPipe) id: string): Promise<JobGroupView[]> {
    return this.groups.jobGroups(id);
  }

  /** Group jobs: ignore, lock or reactivate a stored group. */
  @Patch(':id/groups/:groupId')
  updateGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body(new ZodPipe(UpdateJobGroupDto)) dto: UpdateJobGroupDto,
  ): Promise<JobGroupView> {
    return this.groups.updateJobGroup(id, groupId, dto);
  }

  /** Group jobs: insights over the asset index (trip albums: inferred home per month). */
  @Get(':id/insights')
  insights(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.groups.insights(id);
  }

  @Get(':id/runs')
  listRuns(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(PageQuery)) page: PageQuery,
  ): Promise<{ items: JobRunEntity[]; total: number }> {
    return this.runs.listForJob(id, page);
  }
}
