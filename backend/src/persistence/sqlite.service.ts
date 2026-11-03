import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Database } from 'better-sqlite3';
import { DataSource } from 'typeorm';

/**
 * Raw access to the better-sqlite3 handle for synchronous, atomic writes.
 *
 * TypeORM's SQLite driver shares ONE query runner, so two async TypeORM
 * transactions (e.g. two runs, or a run and an API request) would interleave
 * or fail. A synchronous better-sqlite3 transaction cannot interleave with
 * anything in Node. Rule: multi-statement writes go through `transaction()`;
 * elsewhere use single-statement `insert`/`update`/`delete` (never `save()`,
 * which opens a TypeORM transaction).
 */
@Injectable()
export class SqliteService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  get db(): Database {
    return (
      this.dataSource.driver as unknown as { databaseConnection: Database }
    ).databaseConnection;
  }

  /** Runs `fn` in one synchronous transaction; rolls back if it throws. */
  transaction<T>(fn: (db: Database) => T): T {
    const db = this.db;
    return db.transaction(() => fn(db))();
  }
}
