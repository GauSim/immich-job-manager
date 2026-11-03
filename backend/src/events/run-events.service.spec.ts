import type { RunEvent } from './run-events.service.js';
import { RunEventsService } from './run-events.service.js';

const totals = (scanned: number) => ({
  scanned,
  matched: 0,
  added: 0,
  removed: 0,
  filesRead: 0,
  cacheHits: 0,
});

describe('RunEventsService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const collect = (svc: RunEventsService, runId: string) => {
    const events: RunEvent[] = [];
    let completed = false;
    svc.stream(runId).subscribe({
      next: (e) => events.push(e),
      complete: () => (completed = true),
    });
    return { events, completed: () => completed };
  };

  it('throttles progress to one event per interval, keeping the latest totals', () => {
    const svc = new RunEventsService(1000);
    const { events } = collect(svc, 'r1');
    svc.progress('r1', totals(1)); // leading edge: immediately
    svc.progress('r1', totals(2));
    svc.progress('r1', totals(3));
    expect(events.map((e) => e.data)).toEqual([totals(1)]);
    vi.advanceTimersByTime(999);
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(events.map((e) => e.data)).toEqual([totals(1), totals(3)]); // trailing edge, latest only
  });

  it('passes log lines through immediately', () => {
    const svc = new RunEventsService(1000);
    const { events } = collect(svc, 'r1');
    svc.log('r1', 'info', 'hello', new Date('2026-01-01T00:00:00Z'));
    expect(events).toEqual([
      {
        type: 'log',
        data: {
          level: 'info',
          message: 'hello',
          ts: '2026-01-01T00:00:00.000Z',
        },
      },
    ]);
  });

  it('flushes pending progress before a terminal status and completes', () => {
    const svc = new RunEventsService(1000);
    const s = collect(svc, 'r1');
    svc.progress('r1', totals(1));
    svc.progress('r1', totals(5));
    svc.status('r1', 'succeeded', null, totals(5));
    expect(s.events.map((e) => e.type)).toEqual([
      'progress',
      'progress',
      'status',
    ]);
    expect(s.events[2].data).toMatchObject({ status: 'succeeded', scanned: 5 });
    expect(s.completed()).toBe(true);
  });

  it('keeps the stream open on non-terminal status', () => {
    const svc = new RunEventsService(1000);
    const s = collect(svc, 'r1');
    svc.status('r1', 'running', null);
    expect(s.completed()).toBe(false);
  });

  it('keeps runs independent', () => {
    const svc = new RunEventsService(1000);
    const a = collect(svc, 'a');
    const b = collect(svc, 'b');
    svc.progress('a', totals(1));
    svc.progress('b', totals(2));
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });
});
