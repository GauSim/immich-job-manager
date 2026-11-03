import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { MAX_FAILED_LOGINS } from '../src/auth/auth.service.js';
import { loadConfig } from '../src/config/config.schema.js';
import { FakeImmichServer } from './support/fake-immich-server.js';

describe('Auth (e2e, AUTH_MODE=password)', () => {
  let immich: FakeImmichServer;
  let dataDir: string;
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    immich = await new FakeImmichServer().start();
    immich.on('GET /server/version', () => ({
      json: { major: 3, minor: 3, patch: 5 },
    }));
    dataDir = mkdtempSync(join(tmpdir(), 'iaj-auth-e2e-'));
    const config = loadConfig({
      IMMICH_URL: immich.url,
      IMMICH_API_KEY: 'k',
      APP_PASSWORD: 'correct horse',
      DATA_DIR: dataDir,
      NODE_ENV: 'production',
      LOG_LEVEL: 'fatal',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(config)],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.init();
    http = request(app.getHttpServer());
  });

  afterEach(async () => {
    await app.close();
    await immich.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const login = (password = 'correct horse') =>
    http.post('/api/auth/login').send({ password });
  const cookieOf = (res: request.Response) =>
    (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];

  it('protects the API but not health and session', async () => {
    await http.get('/api/jobs').expect(401);
    await http.get('/api/job-types').expect(401);
    await http
      .get('/api/assets/00000000-0000-4000-8000-000000000000/thumbnail')
      .expect(401);
    await http
      .get('/api/runs/00000000-0000-4000-8000-000000000000/events')
      .expect(401);
    expect((await http.get('/api/auth/session').expect(200)).body).toEqual({
      mode: 'password',
      authenticated: false,
    });
    // Health is public for the Docker healthcheck but reveals no details without a session.
    expect((await http.get('/api/health').expect(200)).body).toEqual({
      status: 'ok',
      version: expect.any(String),
    });
  });

  it('logs in with a secure session cookie and logs out', async () => {
    await login('wrong').expect(401);
    const res = await login().expect(204);
    const setCookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(setCookie).toMatch(
      /^iaj_session=[\w-]+\.[\w-]+; Max-Age=2592000; Path=\/; Expires=.*; HttpOnly; SameSite=Strict$/,
    );
    expect(setCookie).not.toContain('Secure'); // plain HTTP

    const cookie = cookieOf(res);
    await http.get('/api/jobs').set('Cookie', cookie).expect(200);
    expect(
      (await http.get('/api/auth/session').set('Cookie', cookie).expect(200))
        .body.authenticated,
    ).toBe(true);
    expect(
      (await http.get('/api/health').set('Cookie', cookie).expect(200)).body,
    ).toMatchObject({
      immich: { status: 'up', version: 'v3.3.5' },
    });

    const out = await http
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .expect(204);
    expect((out.headers['set-cookie'] as unknown as string[])[0]).toMatch(
      /^iaj_session=; .*Expires=Thu, 01 Jan 1970/,
    );
  });

  it('marks the cookie Secure behind an HTTPS proxy', async () => {
    const res = await http
      .post('/api/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .send({ password: 'correct horse' })
      .expect(204);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain(
      '; Secure',
    );
  });

  it('rejects forged cookies', async () => {
    const cookie = cookieOf(await login().expect(204));
    await http.get('/api/jobs').set('Cookie', `${cookie}x`).expect(401);
    await http
      .get('/api/jobs')
      .set('Cookie', 'iaj_session=abc.def')
      .expect(401);
  });

  it('slows down password guessing', async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++)
      await login(`guess ${i}`).expect(401);
    const locked = await login().expect(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('validates the login body', async () => {
    const res = await http.post('/api/auth/login').send({}).expect(400);
    expect(res.body.errors).toEqual([
      { path: ['password'], message: expect.any(String) },
    ]);
  });
});
