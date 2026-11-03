import {
  HttpContextToken,
  HttpErrorResponse,
  type HttpHandlerFn,
  type HttpInterceptorFn,
  type HttpRequest,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { catchError, switchMap, throwError, type Observable } from 'rxjs';
import type { FieldError } from './models';

/** Set on a request to suppress the snackbar (e.g. background health polling). */
export const SILENT_ERRORS = new HttpContextToken<boolean>(() => false);

/** True for `400 { message: 'Validation failed', errors: [...] }` — forms show these per field. */
export function isValidationError(
  err: unknown,
): err is HttpErrorResponse & { error: { errors: FieldError[] } } {
  return err instanceof HttpErrorResponse && err.status === 400 && Array.isArray(err.error?.errors);
}

/** Human-readable message from a backend error response. */
export function errorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'Cannot reach the server';
    const message = err.error?.message;
    if (typeof message === 'string' && message) return message;
    if (Array.isArray(message)) return message.join(', ');
    return `${err.status} ${err.statusText || 'Error'}`;
  }
  return (err as Error)?.message ?? String(err);
}

const isTransient = (err: HttpErrorResponse) => err.status === 0 || err.status >= 500;

/**
 * One place for HTTP errors (SDD §9.4):
 * - validation errors pass through untouched (shown on the matching form field);
 * - transient errors (network, 5xx) show a snackbar with "Retry", which re-sends the request;
 * - other errors show a snackbar with the server message and are rethrown.
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const snackBar = inject(MatSnackBar);
  return send(req, next, snackBar);
};

function send(
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
  snackBar: MatSnackBar,
): Observable<never> | ReturnType<HttpHandlerFn> {
  return next(req).pipe(
    catchError((err: unknown) => {
      if (
        !(err instanceof HttpErrorResponse) ||
        req.context.get(SILENT_ERRORS) ||
        isValidationError(err)
      ) {
        return throwError(() => err);
      }
      if (!isTransient(err)) {
        snackBar.open(errorMessage(err), 'Dismiss', { duration: 6000 });
        return throwError(() => err);
      }
      const ref = snackBar.open(errorMessage(err), 'Retry', { duration: 10_000 });
      return ref
        .afterDismissed()
        .pipe(
          switchMap(({ dismissedByAction }) =>
            dismissedByAction ? send(req, next, snackBar) : throwError(() => err),
          ),
        );
    }),
  );
}
