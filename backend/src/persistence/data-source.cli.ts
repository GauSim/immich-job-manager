/**
 * Data source for the TypeORM CLI (migration:generate / run / revert).
 * Used against the compiled output, see the `migration:*` npm scripts.
 * Database: $DATA_DIR/app.db, default ./data.
 */
import { DataSource } from 'typeorm';
import { buildDataSourceOptions, databasePath } from './data-source.options.js';

export default new DataSource(
  buildDataSourceOptions(databasePath(process.env.DATA_DIR ?? './data')),
);
