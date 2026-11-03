import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Subject } from 'rxjs';
import { errorInterceptor, errorMessage } from './error.interceptor';

describe('errorInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let opened: {
    message: string;
    action?: string;
    dismissed: Subject<{ dismissedByAction: boolean }>;
  }[];

  beforeEach(() => {
    opened = [];
    const snackBar = {
      open: (message: string, action?: string) => {
        const dismissed = new Subject<{ dismissedByAction: boolean }>();
        opened.push({ message, action, dismissed });
        return { afterDismissed: () => dismissed.asObservable() };
      },
    };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        { provide: MatSnackBar, useValue: snackBar },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  it('passes validation errors through without a snackbar', () => {
    let error: unknown;
    http.post('/api/jobs', {}).subscribe({ error: (e) => (error = e) });
    backend
      .expectOne('/api/jobs')
      .flush(
        { message: 'Validation failed', errors: [{ path: ['name'], message: 'is required' }] },
        { status: 400, statusText: 'Bad Request' },
      );
    expect(opened).toEqual([]);
    expect((error as { status: number }).status).toBe(400);
  });

  it('shows the server message for other client errors and rethrows', () => {
    let error: unknown;
    http.post('/api/jobs/x/runs', {}).subscribe({ error: (e) => (error = e) });
    backend
      .expectOne('/api/jobs/x/runs')
      .flush(
        { message: 'The job already has a queued or running run' },
        { status: 409, statusText: 'Conflict' },
      );
    expect(opened.map((o) => [o.message, o.action])).toEqual([
      ['The job already has a queued or running run', 'Dismiss'],
    ]);
    expect(error).toBeTruthy();
  });

  it('offers Retry for transient errors and re-sends the request', () => {
    let result: unknown;
    http.get('/api/jobs').subscribe((r) => (result = r));
    backend
      .expectOne('/api/jobs')
      .flush({ message: 'boom' }, { status: 503, statusText: 'Unavailable' });
    expect(opened[0]).toMatchObject({ message: 'boom', action: 'Retry' });
    opened[0].dismissed.next({ dismissedByAction: true });
    backend.expectOne('/api/jobs').flush([{ id: 'j1' }]);
    expect(result).toEqual([{ id: 'j1' }]);
  });

  it('rethrows transient errors when the snackbar is dismissed', () => {
    let error: unknown;
    http.get('/api/jobs').subscribe({ error: (e) => (error = e) });
    backend.expectOne('/api/jobs').error(new ProgressEvent('error'));
    expect(opened[0]).toMatchObject({ message: 'Cannot reach the server', action: 'Retry' });
    opened[0].dismissed.next({ dismissedByAction: false });
    expect(error).toBeTruthy();
  });

  it('formats messages', () => {
    expect(errorMessage(new Error('x'))).toBe('x');
  });
});
