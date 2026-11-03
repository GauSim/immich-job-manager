import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import { ENTITIES } from './entities/index.js';
import { MIGRATIONS } from './migrations/index.js';
import { SnakeNamingStrategy } from './snake-naming.strategy.js';

export const DB_FILE_NAME = 'app.db';

/**
 * TypeORM options shared by the app and the migration CLI.
 * Entities and migrations are listed as classes (no globs), which works with
 * ESM and keeps the build self-contained.
 *
 * @param database file path, or ':memory:' for tests
 */
export function buildDataSourceOptions(database: string): DataSourceOptions {
  return {
    type: 'better-sqlite3',
    database,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    migrationsRun: false,
    // WAL lets the UI read while a run writes; busy timeout absorbs short lock waits.
    enableWAL: database !== ':memory:',
    timeout: 5000,
    prepareDatabase: (db: { pragma: (sql: string) => unknown }) => {
      db.pragma('foreign_keys = ON');
      db.pragma('synchronous = NORMAL');
    },
  };
}

/** `<dataDir>/app.db`, creating `dataDir` if needed. */
export function databasePath(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, DB_FILE_NAME);
}
