import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { JobTypeRegistry } from '../core/job-type.registry.js';
import { NoopTestJob } from './noop-test/noop-test.job.js';
import { ScreenshotJob } from './screenshot/screenshot.job.js';

/** Every job type. Add new ones here; they are discovered via `@AlbumJobType()`. */
export const JOB_TYPES = [ScreenshotJob, NoopTestJob];

@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [JobTypeRegistry, ...JOB_TYPES],
  exports: [JobTypeRegistry],
})
export class JobTypesModule {}
