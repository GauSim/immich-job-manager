import { Logger } from '@nestjs/common';
import { RunInterruptedError } from './run-errors.js';

export interface RunExecutorLike {
  execute(runId: string, signal: AbortSignal): Promise<void>;
}

interface ActiveRun {
  jobId: string;
  controller: AbortController;
  done: Promise<void>;
}

/**
 * In-process FIFO queue: at most one active run per job and
 * `maxConcurrent` overall. A queued run whose job is busy keeps its place
 * while later runs of other jobs may start.
 */
export class RunQueue {
  private readonly logger = new Logger(RunQueue.name);
  private readonly queued: { runId: string; jobId: string }[] = [];
  private readonly active = new Map<string, ActiveRun>();
  private idleWaiters: (() => void)[] = [];
  private closed = false;

  constructor(
    private readonly maxConcurrent: number,
    private readonly executor: RunExecutorLike,
  ) {}

  enqueue(runId: string, jobId: string): void {
    if (this.closed) throw new Error('Run queue is shut down');
    if (this.active.has(runId) || this.queued.some((q) => q.runId === runId))
      return;
    this.queued.push({ runId, jobId });
    this.pump();
  }

  /** Removes a queued (not yet started) run. */
  removeQueued(runId: string): boolean {
    const i = this.queued.findIndex((q) => q.runId === runId);
    if (i < 0) return false;
    this.queued.splice(i, 1);
    this.notifyIdle();
    return true;
  }

  /** Aborts an active run with the given reason. */
  abort(runId: string, reason: Error): boolean {
    const run = this.active.get(runId);
    if (!run) return false;
    run.controller.abort(reason);
    return true;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  get activeCount(): number {
    return this.active.size;
  }

  get queuedRunIds(): string[] {
    return this.queued.map((q) => q.runId);
  }

  /** Resolves when nothing is queued or running (tests, shutdown). */
  idle(): Promise<void> {
    if (this.queued.length === 0 && this.active.size === 0)
      return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stops accepting work, interrupts active runs and waits for them to save state. */
  async shutdown(): Promise<void> {
    this.closed = true;
    this.queued.length = 0; // stay 'queued' in the DB; re-enqueued on next boot
    for (const run of this.active.values())
      run.controller.abort(new RunInterruptedError());
    await Promise.allSettled([...this.active.values()].map((r) => r.done));
  }

  private pump(): void {
    while (!this.closed && this.active.size < this.maxConcurrent) {
      const busyJobs = new Set([...this.active.values()].map((r) => r.jobId));
      const i = this.queued.findIndex((q) => !busyJobs.has(q.jobId));
      if (i < 0) break;
      const [next] = this.queued.splice(i, 1);
      this.start(next.runId, next.jobId);
    }
    this.notifyIdle();
  }

  private start(runId: string, jobId: string): void {
    const controller = new AbortController();
    const done = this.executor
      .execute(runId, controller.signal)
      .catch((e: Error) =>
        this.logger.error(`Run ${runId} crashed: ${e.message}`, e.stack),
      )
      .finally(() => {
        this.active.delete(runId);
        this.pump();
      });
    this.active.set(runId, { jobId, controller, done });
  }

  private notifyIdle(): void {
    if (this.queued.length > 0 || this.active.size > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}
