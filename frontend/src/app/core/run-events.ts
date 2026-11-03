import { Observable } from 'rxjs';
import { TERMINAL_STATUSES, type RunEvent } from './models';

/**
 * Live run events via `EventSource` (`GET /api/runs/:id/events`).
 * Completes after a terminal status; the browser reconnects on transient drops.
 */
export function runEvents(
  runId: string,
  factory: (url: string) => EventSource = (u) => new EventSource(u),
): Observable<RunEvent> {
  return new Observable<RunEvent>((subscriber) => {
    const source = factory(`/api/runs/${runId}/events`);
    const on = (type: RunEvent['type']) => (e: MessageEvent<string>) => {
      const event = { type, data: JSON.parse(e.data) } as RunEvent;
      subscriber.next(event);
      if (event.type === 'status' && TERMINAL_STATUSES.includes(event.data.status)) {
        source.close();
        subscriber.complete();
      }
    };
    source.addEventListener('status', on('status') as EventListener);
    source.addEventListener('progress', on('progress') as EventListener);
    source.addEventListener('log', on('log') as EventListener);
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) subscriber.complete();
    };
    return () => source.close();
  });
}
