import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import type { RunStatus } from '../persistence/entities/index.js';
import type { RunLogLevel } from '../persistence/entities/index.js';
import type { RunTotals } from '../runner/run-store.js';

export type RunEvent =
  | { type: 'progress'; data: RunTotals }
  | { type: 'log'; data: { level: RunLogLevel; message: string; ts: string } }
  | {
      type: 'status';
      data: { status: RunStatus; error: string | null } & Partial<RunTotals>;
    };

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
];

/** Min interval between progress events per run (SDD §8.1: 1 event/s). */
export const PROGRESS_INTERVAL_MS = 1000;

interface RunChannel {
  subject: Subject<RunEvent>;
  lastProgressAt: number;
  pendingProgress?: RunTotals;
  timer?: NodeJS.Timeout;
}

/**
 * In-process pub/sub for live run updates (consumed by the SSE endpoint).
 * Progress is throttled to one event per second per run (leading + trailing);
 * log and status events pass through immediately. A terminal status flushes
 * pending progress and completes the stream.
 */
@Injectable()
export class RunEventsService implements OnModuleDestroy {
  private readonly channels = new Map<string, RunChannel>();

  constructor(private readonly intervalMs = PROGRESS_INTERVAL_MS) {}

  stream(runId: string): Observable<RunEvent> {
    return this.channel(runId).subject.asObservable();
  }

  progress(runId: string, totals: RunTotals): void {
    const ch = this.channel(runId);
    ch.pendingProgress = totals;
    if (ch.timer) return;
    const wait = ch.lastProgressAt + this.intervalMs - Date.now();
    if (wait <= 0) this.flushProgress(runId, ch);
    else ch.timer = setTimeout(() => this.flushProgress(runId, ch), wait);
  }

  log(runId: string, level: RunLogLevel, message: string, ts: Date): void {
    this.channels.get(runId)?.subject.next({
      type: 'log',
      data: { level, message, ts: ts.toISOString() },
    });
  }

  status(
    runId: string,
    status: RunStatus,
    error: string | null,
    totals?: RunTotals,
  ): void {
    const ch = this.channels.get(runId);
    if (!ch) return;
    if (ch.timer) clearTimeout(ch.timer);
    ch.timer = undefined;
    if (ch.pendingProgress) this.flushProgress(runId, ch);
    ch.subject.next({ type: 'status', data: { status, error, ...totals } });
    if (TERMINAL_STATUSES.includes(status)) {
      ch.subject.complete();
      this.channels.delete(runId);
    }
  }

  onModuleDestroy(): void {
    for (const ch of this.channels.values()) {
      if (ch.timer) clearTimeout(ch.timer);
      ch.subject.complete();
    }
    this.channels.clear();
  }

  private channel(runId: string): RunChannel {
    let ch = this.channels.get(runId);
    if (!ch) {
      ch = { subject: new Subject(), lastProgressAt: 0 };
      this.channels.set(runId, ch);
    }
    return ch;
  }

  private flushProgress(runId: string, ch: RunChannel): void {
    ch.timer = undefined;
    if (!ch.pendingProgress) return;
    ch.subject.next({ type: 'progress', data: ch.pendingProgress });
    ch.pendingProgress = undefined;
    ch.lastProgressAt = Date.now();
  }
}
