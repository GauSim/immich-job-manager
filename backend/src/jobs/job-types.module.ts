import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { JobTypeRegistry } from '../core/job-type.registry.js';
import { NoopTestJob } from './noop-test/noop-test.job.js';

/** Every job type. Add new ones here; they are discovered via `@AlbumJobType()`. */
export const JOB_TYPES = [NoopTestJob];

@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [JobTypeRegistry, ...JOB_TYPES],
  exports: [JobTypeRegistry],
})
export class JobTypesModule {}
