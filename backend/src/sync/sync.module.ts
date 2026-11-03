import { Global, Module } from '@nestjs/common';
import { AssetIndexModule } from '../asset-index/asset-index.service.js';
import { GroupsModule } from '../groups/group-store.js';
import { AlbumSyncService } from './album-sync.service.js';
import { GroupAlbumSync } from './group-album-sync.js';
import { JobLocks } from './job-locks.js';

/** Album sync primitives, shared by the runner and the API (apply). */
@Global()
@Module({
  imports: [AssetIndexModule, GroupsModule],
  providers: [AlbumSyncService, GroupAlbumSync, JobLocks],
  exports: [AlbumSyncService, GroupAlbumSync, JobLocks],
})
export class SyncModule {}
