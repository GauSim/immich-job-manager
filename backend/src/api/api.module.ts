import { Module } from '@nestjs/common';
import { RunnerModule } from '../runner/runner.module.js';
import { JobsController, JobTypesController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';
import { RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';

@Module({
  imports: [RunnerModule],
  controllers: [JobTypesController, JobsController, RunsController],
  providers: [JobsService, RunsService],
})
export class ApiModule {}
