import { runEvents } from './run-events';
import type { RunEvent } from './models';

class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 1;
  closed = false;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, (e: MessageEvent<string>) => void>();
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, fn);
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
  close() {
    this.closed = true;
  }
}

describe('runEvents', () => {
  it('emits typed events and completes on a terminal status', () => {
    let source!: FakeEventSource;
    const events: RunEvent[] = [];
    let completed = false;
    runEvents(
      'r1',
      (url) => (source = new FakeEventSource(url)) as unknown as EventSource,
    ).subscribe({
      next: (e) => events.push(e),
      complete: () => (completed = true),
    });
    expect(source.url).toBe('/api/runs/r1/events');
    source.emit('status', { status: 'running', error: null });
    source.emit('progress', { scanned: 10 });
    source.emit('log', { level: 'info', message: 'hi', ts: 't' });
    expect(completed).toBe(false);
    source.emit('status', { status: 'succeeded', error: null });
    expect(events.map((e) => e.type)).toEqual(['status', 'progress', 'log', 'status']);
    expect(completed).toBe(true);
    expect(source.closed).toBe(true);
  });

  it('closes the connection on unsubscribe', () => {
    let source!: FakeEventSource;
    const sub = runEvents(
      'r1',
      (url) => (source = new FakeEventSource(url)) as unknown as EventSource,
    ).subscribe();
    sub.unsubscribe();
    expect(source.closed).toBe(true);
  });
});
