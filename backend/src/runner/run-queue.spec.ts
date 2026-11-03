import { RunInterruptedError } from './run-errors.js';
import { RunQueue } from './run-queue.js';

/** Executor whose runs finish only when the test says so. */
class ManualExecutor {
  started: string[] = [];
  signals = new Map<string, AbortSignal>();
  private resolvers = new Map<string, () => void>();

  execute(runId: string, signal: AbortSignal): Promise<void> {
    this.started.push(runId);
    this.signals.set(runId, signal);
    return new Promise((resolve) => {
      this.resolvers.set(runId, resolve);
      signal.addEventListener('abort', () => resolve());
    });
  }

  finish(runId: string): Promise<void> {
    this.resolvers.get(runId)?.();
    return new Promise((r) => setImmediate(r)); // let the queue pump
  }
}

describe('RunQueue', () => {
  let exec: ManualExecutor;

  beforeEach(() => (exec = new ManualExecutor()));

  it('runs at most maxConcurrent at once, FIFO', async () => {
    const q = new RunQueue(2, exec);
    q.enqueue('r1', 'j1');
    q.enqueue('r2', 'j2');
    q.enqueue('r3', 'j3');
    expect(exec.started).toEqual(['r1', 'r2']);
    expect(q.queuedRunIds).toEqual(['r3']);
    await exec.finish('r1');
    expect(exec.started).toEqual(['r1', 'r2', 'r3']);
  });

  it('never runs two runs of the same job, but lets other jobs pass', async () => {
    const q = new RunQueue(2, exec);
    q.enqueue('a1', 'jobA');
    q.enqueue('a2', 'jobA');
    q.enqueue('b1', 'jobB');
    expect(exec.started).toEqual(['a1', 'b1']);
    await exec.finish('b1');
    expect(exec.started).toEqual(['a1', 'b1']); // a2 still waits for a1
    await exec.finish('a1');
    expect(exec.started).toEqual(['a1', 'b1', 'a2']);
  });

  it('ignores duplicate enqueues and supports removing queued runs', async () => {
    const q = new RunQueue(1, exec);
    q.enqueue('r1', 'j1');
    q.enqueue('r1', 'j1');
    q.enqueue('r2', 'j2');
    expect(q.removeQueued('r2')).toBe(true);
    expect(q.removeQueued('r2')).toBe(false);
    await exec.finish('r1');
    expect(exec.started).toEqual(['r1']);
    await q.idle();
  });

  it('aborts an active run with the given reason', () => {
    const q = new RunQueue(1, exec);
    q.enqueue('r1', 'j1');
    const reason = new Error('stop');
    expect(q.abort('r1', reason)).toBe(true);
    expect(exec.signals.get('r1')?.reason).toBe(reason);
    expect(q.abort('nope', reason)).toBe(false);
  });

  it('keeps going when an executor throws', async () => {
    const q = new RunQueue(1, {
      execute: async (id) =>
        id === 'bad' ? Promise.reject(new Error('boom')) : undefined,
    });
    q.enqueue('bad', 'j1');
    q.enqueue('good', 'j2');
    await q.idle();
    expect(q.activeCount).toBe(0);
  });

  it('shutdown interrupts active runs, drops the queue and refuses new work', async () => {
    const q = new RunQueue(1, exec);
    q.enqueue('r1', 'j1');
    q.enqueue('r2', 'j2');
    await q.shutdown();
    expect(exec.signals.get('r1')?.reason).toBeInstanceOf(RunInterruptedError);
    expect(exec.started).toEqual(['r1']);
    expect(() => q.enqueue('r3', 'j3')).toThrow(/shut down/);
  });
});
