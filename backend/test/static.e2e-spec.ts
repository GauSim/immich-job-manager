import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.schema.js';
import { FakeImmichServer } from './support/fake-immich-server.js';

describe('UI static files (e2e)', () => {
  let immich: FakeImmichServer;
  let dir: string;
  let app: INestApplication<App>;

  beforeEach(async () => {
    immich = await new FakeImmichServer().start();
    immich.on('GET /server/version', () => ({
      json: { major: 3, minor: 3, patch: 5 },
    }));
    dir = mkdtempSync(join(tmpdir(), 'iaj-static-'));
    mkdirSync(join(dir, 'public'));
    writeFileSync(
      join(dir, 'public', 'index.html'),
      '<html><body>app</body></html>',
    );
    writeFileSync(join(dir, 'public', 'main-ABC.js'), 'console.log(1)');
    const config = loadConfig({
      IMMICH_URL: immich.url,
      IMMICH_API_KEY: 'k',
      APP_PASSWORD: 'p',
      AUTH_MODE: 'forward-auth', // auth is covered by auth.e2e-spec
      DATA_DIR: join(dir, 'data'),
      PUBLIC_DIR: join(dir, 'public'),
      NODE_ENV: 'production',
      LOG_LEVEL: 'fatal',
    });
    // NestFactory (not Test.createTestingModule): ServeStaticModule picks its
    // Express loader at module creation and needs the HTTP adapter to exist by then.
    app = await NestFactory.create<INestApplication<App>>(
      AppModule.register(config),
      { logger: false },
    );
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await immich.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves index.html, assets and SPA routes', async () => {
    const http = request(app.getHttpServer());
    expect((await http.get('/').expect(200)).text).toContain('app');
    expect((await http.get('/jobs/123').expect(200)).text).toContain('app'); // SPA fallback
    expect((await http.get('/main-ABC.js').expect(200)).text).toBe(
      'console.log(1)',
    );
  });

  it('keeps /api routes and JSON 404s for unknown API paths', async () => {
    const http = request(app.getHttpServer());
    await http.get('/api/health').expect(200).expect('content-type', /json/);
    const res = await http.get('/api/does-not-exist').expect(404);
    expect(res.body).toMatchObject({ statusCode: 404 });
  });
});
