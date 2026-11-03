import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.schema.js';
import { FakeImmichServer } from './support/fake-immich-server.js';

describe('Settings and job export/import (e2e)', () => {
  let immich: FakeImmichServer;
  const dirs: string[] = [];
  const apps: INestApplication<App>[] = [];

  async function boot() {
    const dataDir = mkdtempSync(join(tmpdir(), 'iaj-settings-e2e-'));
    dirs.push(dataDir);
    const config = loadConfig({
      IMMICH_URL: immich.url,
      IMMICH_API_KEY: 'k',
      AUTH_MODE: 'forward-auth',
      DATA_DIR: dataDir,
      TZ: 'Europe/Berlin',
      NODE_ENV: 'production',
      LOG_LEVEL: 'fatal',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(config)],
    }).compile();
    const app = moduleRef.createNestApplication<INestApplication<App>>({
      logger: false,
    });
    app.setGlobalPrefix('api');
    await app.init();
    apps.push(app);
    return request(app.getHttpServer());
  }

  beforeEach(async () => {
    immich = await new FakeImmichServer().start();
    immich.on('GET /server/version', () => ({
      json: { major: 3, minor: 3, patch: 5 },
    }));
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    await immich.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('reads and updates runtime settings', async () => {
    const http = await boot();
    const initial = await http.get('/api/settings').expect(200);
    expect(initial.body).toEqual({
      settings: {
        'retention.dryRunCandidates': 5,
        'retention.logDays': 30,
        'defaults.threshold': 0.6,
      },
      app: {
        version: expect.any(String),
        authMode: 'forward-auth',
        timeZone: 'Europe/Berlin',
        maxConcurrentRuns: 2,
        maxFileReads: 4,
        immichUrl: immich.url,
      },
    });
    const updated = await http
      .patch('/api/settings')
      .send({ 'retention.logDays': 90 })
      .expect(200);
    expect(updated.body.settings['retention.logDays']).toBe(90);
    expect(
      (await http.get('/api/settings').expect(200)).body.settings[
        'retention.logDays'
      ],
    ).toBe(90);

    const bad = await http
      .patch('/api/settings')
      .send({ 'retention.logDays': 0, apiKey: 'x' })
      .expect(400);
    expect(bad.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['retention.logDays'] }),
        expect.objectContaining({
          message: expect.stringMatching(/Unrecognized key/),
        }),
      ]),
    );
  });

  it('exports jobs and imports them into another instance', async () => {
    const source = await boot();
    await source
      .post('/api/jobs')
      .send({
        name: 'Screenshots',
        typeId: 'screenshot-detector',
        targetAlbumName: 'Screenshots',
        params: { threshold: 0.7 },
        syncMode: 'additive',
        schedule: '30 2 * * *',
        enabled: true,
      })
      .expect(201);
    await source
      .post('/api/jobs')
      .send({ name: 'Noop', typeId: 'noop-test', targetAlbumName: 'X' })
      .expect(201);

    const exported = await source.get('/api/jobs/export').expect(200);
    expect(exported.headers['content-disposition']).toBe(
      'attachment; filename="immich-album-jobs.json"',
    );
    expect(exported.body).toMatchObject({
      app: 'immich-album-jobs',
      version: 1,
      exportedAt: expect.any(String),
    });
    expect(exported.body.jobs).toEqual([
      expect.objectContaining({
        name: 'Noop',
        typeId: 'noop-test',
        syncMode: 'dry-run',
        schedule: null,
      }),
      expect.objectContaining({
        name: 'Screenshots',
        params: expect.objectContaining({ threshold: 0.7, readIosTag: true }),
        targetAlbumName: 'Screenshots',
        exclusionAlbumName: null,
        syncMode: 'additive',
        schedule: '30 2 * * *',
        enabled: true,
      }),
    ]);
    expect(exported.body.jobs[0]).not.toHaveProperty('id');

    const target = await boot();
    const body = {
      ...exported.body,
      jobs: [
        ...exported.body.jobs,
        { name: 'Broken', typeId: 'nope', targetAlbumName: 'Y' },
      ],
    };
    const imported = await target
      .post('/api/jobs/import')
      .send(body)
      .expect(200);
    expect(imported.body).toEqual({
      created: ['Noop', 'Screenshots'],
      skipped: [],
      failed: [
        {
          index: 2,
          name: 'Broken',
          errors: [{ path: ['typeId'], message: 'unknown job type "nope"' }],
        },
      ],
    });
    const jobs = (await target.get('/api/jobs').expect(200)).body as {
      name: string;
      nextRunAt: string | null;
    }[];
    expect(jobs.find((j) => j.name === 'Screenshots')?.nextRunAt).toBeTruthy(); // schedule registered

    const again = await target
      .post('/api/jobs/import')
      .send(exported.body)
      .expect(200);
    expect(again.body).toEqual({
      created: [],
      skipped: ['Noop', 'Screenshots'],
      failed: [],
    });
    await target.post('/api/jobs/import').send({ jobs: [] }).expect(400);
  });
});
