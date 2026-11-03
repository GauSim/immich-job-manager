import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { Api } from './api';
import type { Health } from './models';

const POLL_MS = 30_000;

/** Backend + Immich status, polled in the background. */
@Injectable({ providedIn: 'root' })
export class HealthStore {
  private readonly api = inject(Api);
  readonly health = signal<Health | null>(null);
  readonly unreachable = signal(false);
  private timer?: ReturnType<typeof setInterval>;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearInterval(this.timer));
  }

  start(): void {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), POLL_MS);
  }

  refresh(): void {
    this.api.health(true).subscribe({
      next: (h) => {
        this.health.set(h);
        this.unreachable.set(false);
      },
      error: (err) => {
        // 503 still carries a health body (database down).
        if (err?.error?.status) this.health.set(err.error as Health);
        else this.unreachable.set(true);
      },
    });
  }
}
