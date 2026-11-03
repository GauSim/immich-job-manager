import { Module } from '@nestjs/common';
import { RunnerModule } from '../runner/runner.module.js';
import { SchedulerModule } from '../scheduler/scheduler.module.js';
import { ApplyService } from '../sync/apply.service.js';
import { AssetsController } from './assets.controller.js';
import { CandidatesService } from './candidates.service.js';
import { JobsController, JobTypesController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';
import { RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';
import { SettingsController } from './settings.controller.js';

@Module({
  imports: [RunnerModule, SchedulerModule],
  controllers: [
    JobTypesController,
    JobsController,
    RunsController,
    AssetsController,
    SettingsController,
  ],
  providers: [JobsService, RunsService, CandidatesService, ApplyService],
})
export class ApiModule {}
