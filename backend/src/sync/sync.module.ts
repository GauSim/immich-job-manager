import { Global, Module } from '@nestjs/common';
import { AlbumSyncService } from './album-sync.service.js';
import { JobLocks } from './job-locks.js';

/** Album sync primitives, shared by the runner and the API (apply). */
@Global()
@Module({
  providers: [AlbumSyncService, JobLocks],
  exports: [AlbumSyncService, JobLocks],
})
export class SyncModule {}
