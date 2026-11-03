import {
  Body,
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
import { CreateJobDto, PageQuery, StartRunDto, UpdateJobDto } from './dto.js';
import { JobsService, type JobView } from './jobs.service.js';
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
  ) {}

  @Get()
  list(): Promise<JobView[]> {
    return this.jobs.list();
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

  @Get(':id/runs')
  listRuns(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(PageQuery)) page: PageQuery,
  ): Promise<{ items: JobRunEntity[]; total: number }> {
    return this.runs.listForJob(id, page);
  }
}
