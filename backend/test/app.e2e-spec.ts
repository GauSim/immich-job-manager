import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.schema.js';
import { MIGRATIONS } from '../src/persistence/migrations/index.js';
import { ImmichIncompatibleError } from '../src/immich/immich.errors.js';
import { FakeImmichServer } from './support/fake-immich-server.js';

describe('App (e2e)', () => {
  let immich: FakeImmichServer;
  let dataDir: string;
  let app: INestApplication<App> | undefined;

  const boot = async () => {
    const config = loadConfig({
      IMMICH_URL: immich.url,
      IMMICH_API_KEY: 'test-key',
      APP_PASSWORD: 'pw',
      AUTH_MODE: 'forward-auth', // auth is covered by auth.e2e-spec
      DATA_DIR: dataDir,
      NODE_ENV: 'production',
      LOG_LEVEL: 'fatal',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(config)],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    return app;
  };

  beforeEach(async () => {
    immich = await new FakeImmichServer().start();
    dataDir = mkdtempSync(join(tmpdir(), 'iaj-e2e-'));
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await immich.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('runs migrations on boot and reports healthy against Immich v3', async () => {
    immich.on('GET /server/version', () => ({
      json: { major: 3, minor: 3, patch: 5 },
    }));
    const a = await boot();

    const res = await request(a.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toEqual({
      status: 'ok',
      version: expect.any(String),
      database: { status: 'up' },
      immich: { status: 'up', version: 'v3.3.5' },
    });
    expect(res.headers['x-request-id']).toBeTruthy();

    const migrations = await a
      .get(DataSource)
      .query('SELECT name FROM migrations');
    expect(migrations).toHaveLength(MIGRATIONS.length);
  });

  it('keeps an incoming x-request-id', async () => {
    immich.on('GET /server/version', () => ({
      json: { major: 3, minor: 0, patch: 0 },
    }));
    const a = await boot();
    const res = await request(a.getHttpServer())
      .get('/api/health')
      .set('x-request-id', 'abc-123');
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('starts while Immich is down and reports degraded', async () => {
    await immich.stop();
    const a = await boot();
    const res = await request(a.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toMatchObject({
      status: 'degraded',
      database: { status: 'up' },
      immich: { status: 'down' },
    });
  });

  it('reports Immich errors with the correlation id', async () => {
    let calls = 0;
    immich.on('GET /server/version', () =>
      calls++ === 0
        ? { json: { major: 3, minor: 0, patch: 0 } }
        : { status: 503 },
    );
    const a = await boot();
    const res = await request(a.getHttpServer()).get('/api/health').expect(200);
    expect(res.body.immich).toMatchObject({
      status: 'down',
      correlationId: expect.stringMatching(/^corr-/),
    });
  });

  it('refuses to boot against an incompatible Immich', async () => {
    immich.on('GET /server/version', () => ({
      json: { major: 2, minor: 9, patch: 0 },
    }));
    await expect(boot()).rejects.toBeInstanceOf(ImmichIncompatibleError);
  });
});
