import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** Validated runtime configuration. Built once at boot from the environment. */
export interface AppConfig {
  immich: {
    /** Immich API base URL including `/api`, without trailing slash. */
    url: string;
    apiKey: string;
  };
  auth: {
    mode: 'password' | 'forward-auth';
    /** Undefined only when `mode` is `forward-auth`. */
    password?: string;
  };
  pyWorkerUrl?: string;
  dataDir: string;
  maxConcurrentRuns: number;
  maxFileReads: number;
  port: number;
  tz: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  nodeEnv: string;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => string;

const defaultReadFile: ReadFile = (path) => readFileSync(path, 'utf8');

const emptyToUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const intWithDefault = (def: number, min: number, max: number) =>
  z.preprocess(
    emptyToUndefined,
    z.coerce
      .number()
      .int('must be an integer')
      .min(min, `must be >= ${min}`)
      .max(max, `must be <= ${max}`)
      .default(def),
  );

const httpUrl = z.url({
  protocol: /^https?$/,
  error: 'must be an http(s) URL',
});

const isValidTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const envSchema = z.object({
  IMMICH_URL: z.preprocess(
    emptyToUndefined,
    httpUrl
      .transform((u) => u.replace(/\/+$/, ''))
      .refine((u) => u.endsWith('/api'), {
        error: 'must include the /api path, e.g. http://immich_server:2283/api',
      }),
  ),
  IMMICH_API_KEY: optionalString,
  APP_PASSWORD: optionalString,
  AUTH_MODE: z.preprocess(
    emptyToUndefined,
    z.enum(['password', 'forward-auth']).default('password'),
  ),
  PY_WORKER_URL: z.preprocess(emptyToUndefined, httpUrl.optional()),
  DATA_DIR: z.preprocess(emptyToUndefined, z.string().default('/data')),
  MAX_CONCURRENT_RUNS: intWithDefault(2, 1, 16),
  MAX_FILE_READS: intWithDefault(4, 1, 32),
  PORT: intWithDefault(3000, 1, 65535),
  TZ: z.preprocess(
    emptyToUndefined,
    z.string().default('UTC').refine(isValidTimeZone, {
      error: 'must be an IANA time zone, e.g. Europe/Berlin',
    }),
  ),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
  ),
  NODE_ENV: z.preprocess(emptyToUndefined, z.string().default('development')),
});

/**
 * Resolves a secret from either `NAME` or `NAME_FILE` (Docker secret).
 * Setting both is an error, to avoid silently picking the wrong one.
 */
function resolveSecret(
  env: Env,
  name: string,
  readFile: ReadFile,
  issues: string[],
): string | undefined {
  const direct = emptyToUndefined(env[name]) as string | undefined;
  const file = emptyToUndefined(env[`${name}_FILE`]) as string | undefined;
  if (direct !== undefined && file !== undefined) {
    issues.push(`${name} / ${name}_FILE: set only one of them`);
    return undefined;
  }
  if (file === undefined) return direct;
  let value: string;
  try {
    value = readFile(file);
  } catch (e) {
    issues.push(
      `${name}_FILE: cannot read ${file} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`,
    );
    return undefined;
  }
  value = value.replace(/\r?\n$/, '');
  if (value.trim() === '') {
    issues.push(`${name}_FILE: ${file} is empty`);
    return undefined;
  }
  return value;
}

/**
 * Validates the environment and builds {@link AppConfig}.
 * Collects all problems and throws one {@link ConfigError} listing them.
 */
export function loadConfig(
  env: Env = process.env,
  readFile: ReadFile = defaultReadFile,
): AppConfig {
  const issues: string[] = [];

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '(env)';
      const message =
        issue.code === 'invalid_type' && issue.input === undefined
          ? 'is required'
          : issue.message;
      issues.push(`${key}: ${message}`);
    }
  }

  const apiKey = resolveSecret(env, 'IMMICH_API_KEY', readFile, issues);
  const password = resolveSecret(env, 'APP_PASSWORD', readFile, issues);

  if (
    apiKey === undefined &&
    !issues.some((i) => i.startsWith('IMMICH_API_KEY'))
  ) {
    issues.push(
      'IMMICH_API_KEY_FILE: is required (or IMMICH_API_KEY for development)',
    );
  }
  const authMode = parsed.success ? parsed.data.AUTH_MODE : 'password';
  if (
    authMode === 'password' &&
    password === undefined &&
    !issues.some((i) => i.startsWith('APP_PASSWORD'))
  ) {
    issues.push(
      'APP_PASSWORD_FILE: is required when AUTH_MODE=password (or APP_PASSWORD for development)',
    );
  }

  if (!parsed.success || issues.length > 0) throw new ConfigError(issues);

  const e = parsed.data;
  return {
    immich: { url: e.IMMICH_URL, apiKey: apiKey! },
    auth: { mode: e.AUTH_MODE, password },
    pyWorkerUrl: e.PY_WORKER_URL,
    dataDir: e.DATA_DIR,
    maxConcurrentRuns: e.MAX_CONCURRENT_RUNS,
    maxFileReads: e.MAX_FILE_READS,
    port: e.PORT,
    tz: e.TZ,
    logLevel: e.LOG_LEVEL,
    nodeEnv: e.NODE_ENV,
  };
}
