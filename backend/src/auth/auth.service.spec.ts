import type { AppConfig } from '../config/config.schema.js';
import {
  AuthService,
  LOCKOUT_MS,
  MAX_FAILED_LOGINS,
  readCookie,
} from './auth.service.js';

const service = (
  password = 'secret',
  mode: 'password' | 'forward-auth' = 'password',
) => new AuthService({ auth: { mode, password } } as AppConfig);

describe('AuthService', () => {
  it('checks the password', () => {
    expect(service().checkPassword('secret')).toBe(true);
    expect(service().checkPassword('Secret')).toBe(false);
  });

  it('issues tokens that verify until they expire', () => {
    const auth = service();
    const now = Date.UTC(2026, 10, 3);
    const { token, maxAgeSeconds } = auth.issue(now);
    expect(maxAgeSeconds).toBe(30 * 86_400);
    expect(auth.verify(token, now + 1000)).toBe(true);
    expect(auth.verify(token, now + 31 * 86_400_000)).toBe(false);
  });

  it('rejects tampered tokens and tokens signed with another password', () => {
    const { token } = service().issue();
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ iat: 0, exp: Date.now() * 2 }),
    ).toString('base64url');
    expect(service().verify(`${forged}.${sig}`)).toBe(false);
    expect(service().verify(`${payload}.x${sig.slice(1)}`)).toBe(false);
    expect(service('other').verify(token)).toBe(false); // changing the password ends sessions
    expect(service().verify('garbage')).toBe(false);
    expect(service().verify(undefined)).toBe(false);
  });

  it('locks a client out after too many failures, then lets it try again', () => {
    const auth = service();
    const t = 1_000_000;
    for (let i = 0; i < MAX_FAILED_LOGINS; i++)
      auth.recordFailure('1.2.3.4', t);
    expect(auth.lockedFor('1.2.3.4', t + 1000)).toBeGreaterThan(0);
    expect(auth.lockedFor('5.6.7.8', t)).toBe(0);
    expect(auth.lockedFor('1.2.3.4', t + LOCKOUT_MS + 1)).toBe(0);
  });

  it('allows everything in forward-auth mode', () => {
    const auth = service(undefined as unknown as string, 'forward-auth');
    expect(auth.enabled).toBe(false);
    expect(auth.isAuthenticated({ headers: {} } as never)).toBe(true);
  });

  it('reads cookies', () => {
    expect(
      readCookie(
        { headers: { cookie: 'a=1; iaj_session=abc%3D; b=2' } } as never,
        'iaj_session',
      ),
    ).toBe('abc=');
    expect(readCookie({ headers: {} } as never, 'iaj_session')).toBeUndefined();
  });
});
