import { ConfigError, loadConfig } from './config.schema.js';

const base = {
  IMMICH_URL: 'http://immich_server:2283/api',
  IMMICH_API_KEY: 'key',
  APP_PASSWORD: 'pw',
};

const noFiles = (path: string): string => {
  throw Object.assign(new Error('nope'), { code: `ENOENT:${path}` });
};

function issuesOf(
  env: Record<string, string | undefined>,
  readFile = noFiles,
): string[] {
  try {
    loadConfig(env, readFile);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).issues;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base, noFiles);
    expect(c).toMatchObject({
      immich: { url: 'http://immich_server:2283/api', apiKey: 'key' },
      auth: { mode: 'password', password: 'pw' },
      dataDir: '/data',
      maxConcurrentRuns: 2,
      maxFileReads: 4,
      port: 3000,
      tz: 'UTC',
      logLevel: 'info',
    });
    expect(c.pyWorkerUrl).toBeUndefined();
  });

  it('strips a trailing slash from IMMICH_URL', () => {
    expect(
      loadConfig({ ...base, IMMICH_URL: 'http://x:2283/api/' }, noFiles).immich
        .url,
    ).toBe('http://x:2283/api');
  });

  it('parses numbers and overrides', () => {
    const c = loadConfig(
      {
        ...base,
        MAX_CONCURRENT_RUNS: '3',
        MAX_FILE_READS: '8',
        PORT: '8080',
        TZ: 'Europe/Berlin',
        DATA_DIR: './data',
      },
      noFiles,
    );
    expect(c).toMatchObject({
      maxConcurrentRuns: 3,
      maxFileReads: 8,
      port: 8080,
      tz: 'Europe/Berlin',
      dataDir: './data',
    });
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ ...base, PORT: '', TZ: '' }, noFiles)).toMatchObject({
      port: 3000,
      tz: 'UTC',
    });
  });

  it('reads secrets from *_FILE and strips one trailing newline', () => {
    const files: Record<string, string> = {
      '/run/secrets/key': 'file-key\n',
      '/run/secrets/pw': 'file-pw',
    };
    const c = loadConfig(
      {
        IMMICH_URL: base.IMMICH_URL,
        IMMICH_API_KEY_FILE: '/run/secrets/key',
        APP_PASSWORD_FILE: '/run/secrets/pw',
      },
      (p) => files[p] ?? noFiles(p),
    );
    expect(c.immich.apiKey).toBe('file-key');
    expect(c.auth.password).toBe('file-pw');
  });

  it('reports all problems at once with readable messages', () => {
    const issues = issuesOf({
      MAX_FILE_READS: 'abc',
      TZ: 'Mars/Base',
      AUTH_MODE: 'none',
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        'IMMICH_URL: is required',
        expect.stringMatching(/^MAX_FILE_READS: /),
        'TZ: must be an IANA time zone, e.g. Europe/Berlin',
        expect.stringMatching(/^AUTH_MODE: /),
        'IMMICH_API_KEY_FILE: is required (or IMMICH_API_KEY for development)',
      ]),
    );
  });

  it('rejects an IMMICH_URL without /api', () => {
    expect(issuesOf({ ...base, IMMICH_URL: 'http://immich:2283' })).toEqual([
      'IMMICH_URL: must include the /api path, e.g. http://immich_server:2283/api',
    ]);
  });

  it('rejects non-http URLs', () => {
    expect(issuesOf({ ...base, IMMICH_URL: 'ftp://immich/api' })).toEqual([
      'IMMICH_URL: must be an http(s) URL',
    ]);
  });

  it('reports unreadable and empty secret files', () => {
    expect(
      issuesOf({
        IMMICH_URL: base.IMMICH_URL,
        IMMICH_API_KEY_FILE: '/missing',
        APP_PASSWORD: 'pw',
      }),
    ).toEqual([
      expect.stringMatching(/^IMMICH_API_KEY_FILE: cannot read \/missing/),
    ]);
    expect(
      issuesOf(
        {
          IMMICH_URL: base.IMMICH_URL,
          IMMICH_API_KEY_FILE: '/empty',
          APP_PASSWORD: 'pw',
        },
        () => '\n',
      ),
    ).toEqual(['IMMICH_API_KEY_FILE: /empty is empty']);
  });

  it('rejects both NAME and NAME_FILE', () => {
    expect(
      issuesOf({ ...base, IMMICH_API_KEY_FILE: '/run/secrets/key' }, () => 'k'),
    ).toEqual(['IMMICH_API_KEY / IMMICH_API_KEY_FILE: set only one of them']);
  });

  it('requires a password unless AUTH_MODE=forward-auth', () => {
    const env = { IMMICH_URL: base.IMMICH_URL, IMMICH_API_KEY: 'k' };
    expect(issuesOf(env)).toEqual([
      'APP_PASSWORD_FILE: is required when AUTH_MODE=password (or APP_PASSWORD for development)',
    ]);
    expect(
      loadConfig({ ...env, AUTH_MODE: 'forward-auth' }, noFiles).auth,
    ).toEqual({
      mode: 'forward-auth',
      password: undefined,
    });
  });

  it('validates PY_WORKER_URL', () => {
    expect(issuesOf({ ...base, PY_WORKER_URL: 'not a url' })).toEqual([
      'PY_WORKER_URL: must be an http(s) URL',
    ]);
  });

  it('formats the error message as a list', () => {
    expect(() => loadConfig({}, noFiles)).toThrow(
      /^Invalid configuration:\n {2}- IMMICH_URL: is required/,
    );
  });
});
