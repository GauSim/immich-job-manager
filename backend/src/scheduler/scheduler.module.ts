import { Module } from '@nestjs/common';
import { RunnerModule } from '../runner/runner.module.js';
import { Housekeeping } from './housekeeping.service.js';
import { JobScheduler } from './job-scheduler.js';

@Module({
  imports: [RunnerModule],
  providers: [JobScheduler, Housekeeping],
  exports: [JobScheduler, Housekeeping],
})
export class SchedulerModule {}
