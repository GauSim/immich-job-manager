import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions, databasePath } from './data-source.options.js';
import { MIGRATIONS } from './migrations/index.js';
import { JobAssetEntity, JobEntity, JobRunEntity } from './entities/index.js';

describe('migrations', () => {
  let dir: string;
  let ds: DataSource;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iaj-db-'));
    ds = await new DataSource(
      buildDataSourceOptions(databasePath(join(dir, 'data'))),
    ).initialize();
    await ds.runMigrations({ transaction: 'each' });
  });

  afterEach(async () => {
    await ds.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('match the entities exactly (no pending schema changes)', async () => {
    const pending = await ds.driver.createSchemaBuilder().log();
    expect(pending.upQueries.map((q) => q.query)).toEqual([]);
  });

  it('create all tables and indexes', async () => {
    const rows: { type: string; name: string }[] = await ds.query(
      `SELECT type, name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    const names = rows.map((r) => r.name);
    for (const table of [
      'job',
      'job_run',
      'run_candidate',
      'job_asset',
      'asset_feature',
      'run_log',
      'setting',
      'migrations',
    ]) {
      expect(names).toContain(table);
    }
    for (const index of [
      'idx_job_run_job_created',
      'idx_job_run_status',
      'idx_run_candidate_run_score',
      'idx_run_candidate_asset',
      'idx_run_log_run',
      'idx_run_log_ts',
    ]) {
      expect(names).toContain(index);
    }
  });

  it('enables WAL and foreign keys', async () => {
    expect(await ds.query('PRAGMA journal_mode')).toEqual([
      { journal_mode: 'wal' },
    ]);
    expect(await ds.query('PRAGMA foreign_keys')).toEqual([
      { foreign_keys: 1 },
    ]);
  });

  it('upgrades an existing database without losing rows', async () => {
    for (let i = 1; i < MIGRATIONS.length; i++)
      await ds.undoLastMigration({ transaction: 'each' }); // back to Init
    await ds.query(
      `INSERT INTO job (id, name, type_id, params) VALUES ('j1', 'old', 'noop-test', '{}')`,
    );
    await ds.query(`INSERT INTO job_run (id, job_id) VALUES ('r1', 'j1')`);
    await ds.query(
      `INSERT INTO run_log (run_id, ts, level, message) VALUES ('r1', '2026-01-01', 'info', 'x')`,
    );
    await ds.runMigrations({ transaction: 'each' });
    expect(
      await ds.query(
        'SELECT id, target_album_name, exclusion_album_name FROM job',
      ),
    ).toEqual([
      { id: 'j1', target_album_name: '', exclusion_album_name: null },
    ]);
    expect(await ds.query('SELECT id FROM job_run')).toEqual([{ id: 'r1' }]);
    expect(await ds.query('SELECT COUNT(*) AS n FROM run_log')).toEqual([
      { n: 1 },
    ]);
  });

  it('round-trips entities and cascades deletes', async () => {
    const job = await ds.getRepository(JobEntity).save({
      name: 'Screenshots',
      typeId: 'screenshot-detector',
      params: { threshold: 0.6 },
    });
    expect(job).toMatchObject({
      syncMode: 'dry-run',
      enabled: false,
      typeVersion: 0,
    });
    const run = await ds
      .getRepository(JobRunEntity)
      .save({ jobId: job.id, dryRun: true });
    await ds.getRepository(JobAssetEntity).save({
      jobId: job.id,
      assetId: 'a1',
      addedByRunId: run.id,
      addedAt: new Date(),
    });

    const loaded = await ds
      .getRepository(JobEntity)
      .findOneByOrFail({ id: job.id });
    expect(loaded.params).toEqual({ threshold: 0.6 });
    expect(
      (await ds.getRepository(JobRunEntity).findOneByOrFail({ id: run.id }))
        .status,
    ).toBe('queued');

    await ds.getRepository(JobEntity).delete(job.id);
    expect(await ds.getRepository(JobRunEntity).count()).toBe(0);
    expect(await ds.getRepository(JobAssetEntity).count()).toBe(0);
  });
});
