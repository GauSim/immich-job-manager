import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import {
  buildDataSourceOptions,
  databasePath,
} from '../persistence/data-source.options.js';
import { SqliteService } from '../persistence/sqlite.service.js';
import { AssetFeatureCache } from './asset-feature-cache.js';

describe('AssetFeatureCache (SQLite)', () => {
  let dir: string;
  let ds: DataSource;
  let cache: AssetFeatureCache;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iaj-features-'));
    ds = await new DataSource(
      buildDataSourceOptions(databasePath(dir)),
    ).initialize();
    await ds.runMigrations();
    cache = new AssetFeatureCache(new SqliteService(ds));
  });

  afterEach(async () => {
    await ds.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores and returns features while the checksum matches', () => {
    cache.setMany([
      { id: 'a', checksum: 'c1', iosScreenshotTag: true },
      { id: 'b', checksum: 'c2', iosScreenshotTag: false },
    ]);
    const got = cache.getMany([
      { id: 'a', checksum: 'c1' },
      { id: 'b', checksum: 'changed' },
      { id: 'c', checksum: 'c3' },
    ]);
    expect([...got]).toEqual([['a', { iosScreenshotTag: true }]]);
  });

  it('updates entries and handles more ids than one SQL chunk', () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({
      id: `id-${i}`,
      checksum: 'x',
      iosScreenshotTag: i % 2 === 0,
    }));
    cache.setMany(many);
    cache.setMany([{ id: 'id-1', checksum: 'y', iosScreenshotTag: true }]);
    const got = cache.getMany(many.map(({ id }) => ({ id, checksum: 'x' })));
    expect(got.size).toBe(1199); // id-1 now has checksum y
    expect(got.get('id-0')).toEqual({ iosScreenshotTag: true });
  });

  it('never caches assets without a checksum', () => {
    cache.setMany([
      {
        id: 'n',
        checksum: undefined as unknown as string,
        iosScreenshotTag: true,
      },
    ]);
    expect(
      cache.getMany([{ id: 'n', checksum: undefined as unknown as string }])
        .size,
    ).toBe(0);
  });
});
