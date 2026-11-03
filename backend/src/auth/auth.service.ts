import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';

export const SESSION_COOKIE = 'iaj_session';
export const SESSION_DAYS = 30;
const DAY_MS = 86_400_000;

/** Failed logins per client before it has to wait (`LOCKOUT_MS`). */
export const MAX_FAILED_LOGINS = 10;
export const LOCKOUT_MS = 15 * 60_000;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/**
 * Single-password auth (SDD §12.1). Sessions are stateless signed cookies:
 * `base64url({iat,exp}).HMAC`. The signing key is derived from APP_PASSWORD,
 * so nothing secret is stored and changing the password ends all sessions.
 */
@Injectable()
export class AuthService {
  private readonly key: Buffer | null;
  private readonly passwordDigest: Buffer | null;
  private readonly failures = new Map<
    string,
    { count: number; since: number }
  >();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    const password = config.auth.password;
    this.key = password
      ? Buffer.from(
          hkdfSync('sha256', password, 'immich-album-jobs', 'session-v1', 32),
        )
      : null;
    this.passwordDigest = password ? sha256(password) : null;
  }

  get mode(): AppConfig['auth']['mode'] {
    return this.config.auth.mode;
  }

  /** forward-auth: the reverse proxy authenticates; every request is allowed. */
  get enabled(): boolean {
    return this.mode === 'password';
  }

  checkPassword(candidate: string): boolean {
    if (!this.passwordDigest) return false;
    return timingSafeEqual(sha256(candidate), this.passwordDigest);
  }

  /** Returns ms to wait if the client is locked out after too many failures. */
  lockedFor(client: string, now = Date.now()): number {
    const f = this.failures.get(client);
    if (!f || f.count < MAX_FAILED_LOGINS) return 0;
    const left = f.since + LOCKOUT_MS - now;
    if (left <= 0) {
      this.failures.delete(client);
      return 0;
    }
    return left;
  }

  recordFailure(client: string, now = Date.now()): void {
    const f = this.failures.get(client);
    if (!f || now - f.since > LOCKOUT_MS)
      this.failures.set(client, { count: 1, since: now });
    else f.count++;
  }

  clearFailures(client: string): void {
    this.failures.delete(client);
  }

  issue(now = Date.now()): { token: string; maxAgeSeconds: number } {
    const payload = b64url(
      JSON.stringify({ iat: now, exp: now + SESSION_DAYS * DAY_MS }),
    );
    return {
      token: `${payload}.${this.sign(payload)}`,
      maxAgeSeconds: SESSION_DAYS * 86_400,
    };
  }

  verify(token: string | undefined, now = Date.now()): boolean {
    if (!token || !this.key) return false;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return false;
    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      return false;
    try {
      const { exp } = JSON.parse(
        Buffer.from(payload, 'base64url').toString(),
      ) as { exp: number };
      return typeof exp === 'number' && exp > now;
    } catch {
      return false;
    }
  }

  /** True if the request may use the API (always in forward-auth mode). */
  isAuthenticated(req: IncomingMessage): boolean {
    return !this.enabled || this.verify(readCookie(req, SESSION_COOKIE));
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key!).update(payload).digest('base64url');
  }
}

function sha256(s: string): Buffer {
  return createHmac('sha256', 'immich-album-jobs').update(s).digest();
}

export function readCookie(
  req: IncomingMessage,
  name: string,
): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** `Secure` only over HTTPS (directly or behind a TLS-terminating proxy). */
export function isHttps(req: IncomingMessage & { secure?: boolean }): boolean {
  return (
    req.secure === true ||
    String(req.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      .trim() === 'https'
  );
}
