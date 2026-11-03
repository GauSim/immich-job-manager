import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import type { AppConfig } from './config/config.schema.js';
import { HealthModule } from './health/health.module.js';
import { ImmichModule } from './immich/immich.module.js';
import { LoggingModule } from './logging/logging.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';

@Module({})
export class AppModule {
  /** The config is validated before Nest starts (see main.ts) and passed in here. */
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggingModule,
        PersistenceModule,
        ImmichModule,
        HealthModule,
      ],
    };
  }
}
