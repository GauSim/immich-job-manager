import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Api } from './api';
import type { AuthSession } from './models';

/** Session state (password login, or forward-auth where everything is allowed). */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly api = inject(Api);
  readonly session = signal<AuthSession | null>(null);

  /** Loads the session once (or again with `force`). */
  async ensure(force = false): Promise<AuthSession> {
    const current = this.session();
    if (current && !force) return current;
    try {
      const s = await firstValueFrom(this.api.session());
      this.session.set(s);
      return s;
    } catch {
      // Server unreachable: let the pages show their errors instead of looping to /login.
      const fallback: AuthSession = { mode: 'password', authenticated: true };
      this.session.set(fallback);
      return fallback;
    }
  }

  async login(password: string): Promise<void> {
    await firstValueFrom(this.api.login(password));
    this.session.set({ mode: 'password', authenticated: true });
  }

  async logout(): Promise<void> {
    await firstValueFrom(this.api.logout());
    this.session.set({ mode: 'password', authenticated: false });
  }

  /** Called when the API answers 401 (session expired). */
  expired(): void {
    const s = this.session();
    this.session.set({ mode: s?.mode ?? 'password', authenticated: false });
  }
}
