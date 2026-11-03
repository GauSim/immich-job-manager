import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { AssetIndexModule } from '../asset-index/asset-index.service.js';
import { GroupsModule } from '../groups/group-store.js';
import { GroupRunExecutor } from './group-run.js';
import { RunExecutor } from './run-executor.js';
import { RunQueue } from './run-queue.js';
import { RunLifecycle } from './run-lifecycle.js';
import { RunStore } from './run-store.js';
import { RunLauncher } from './run-launcher.js';

@Module({
  imports: [AssetIndexModule, GroupsModule],
  providers: [
    RunStore,
    GroupRunExecutor,
    RunExecutor,
    {
      provide: RunQueue,
      inject: [APP_CONFIG, RunExecutor],
      useFactory: (config: AppConfig, executor: RunExecutor) =>
        new RunQueue(config.maxConcurrentRuns, executor),
    },
    RunLifecycle,
    RunLauncher,
  ],
  exports: [RunQueue, RunStore, RunLauncher],
})
export class RunnerModule {}
