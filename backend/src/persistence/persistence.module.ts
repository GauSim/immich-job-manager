import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { AppConfig } from '../config/config.schema.js';
import { APP_CONFIG } from '../config/config.module.js';
import { buildDataSourceOptions, databasePath } from './data-source.options.js';
import { ENTITIES } from './entities/index.js';
import { SqliteService } from './sqlite.service.js';

/**
 * SQLite via TypeORM. Migrations run on boot; `synchronize` is always off.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        ...buildDataSourceOptions(databasePath(config.dataDir)),
        migrationsRun: true,
        migrationsTransactionMode: 'each',
      }),
    }),
    TypeOrmModule.forFeature(ENTITIES),
  ],
  providers: [SqliteService],
  exports: [TypeOrmModule, SqliteService],
})
export class PersistenceModule {}
