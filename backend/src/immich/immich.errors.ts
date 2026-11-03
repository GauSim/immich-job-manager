/** Base class for all errors raised by {@link ImmichClient}. */
export class ImmichError extends Error {
  constructor(
    message: string,
    /** Immich's `x-correlation-id` of the failing response, if any. */
    public readonly correlationId?: string,
    options?: { cause?: unknown },
  ) {
    super(
      correlationId ? `${message} (correlation id ${correlationId})` : message,
      options,
    );
    this.name = 'ImmichError';
  }
}

/** Immich answered with a non-2xx status (after retries). */
export class ImmichApiError extends ImmichError {
  constructor(
    public readonly operation: string,
    public readonly status: number,
    public readonly body: unknown,
    correlationId?: string,
  ) {
    super(
      `Immich ${operation} failed with HTTP ${status}: ${describeBody(body)}`,
      correlationId,
    );
    this.name = 'ImmichApiError';
  }
}

/** Immich could not be reached (network error, DNS, timeout) after retries. */
export class ImmichUnreachableError extends ImmichError {
  constructor(operation: string, cause: unknown) {
    super(
      `Immich ${operation} failed: ${(cause as Error)?.message ?? String(cause)}`,
      undefined,
      { cause },
    );
    this.name = 'ImmichUnreachableError';
  }
}

/** The server is not an Immich v3.x. */
export class ImmichIncompatibleError extends ImmichError {
  constructor(public readonly version: string) {
    super(`Immich ${version} is not supported; this app requires Immich v3.x`);
    this.name = 'ImmichIncompatibleError';
  }
}

/** Smart (CLIP) search failed server side, typically because Immich ML is not running. */
export class ImmichSmartSearchUnavailableError extends ImmichError {
  constructor(correlationId?: string) {
    super(
      'Immich smart search is unavailable (is the machine-learning container running?)',
      correlationId,
    );
    this.name = 'ImmichSmartSearchUnavailableError';
  }
}

function describeBody(body: unknown): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const { message, errors } = body as {
      message: unknown;
      errors?: { path?: unknown[]; message?: string }[];
    };
    const details = Array.isArray(errors)
      ? errors
          .map((e) => `${(e.path ?? []).join('.')}: ${e.message}`)
          .join('; ')
      : '';
    return details ? `${String(message)} (${details})` : String(message);
  }
  if (typeof body === 'string') return body.slice(0, 200);
  return JSON.stringify(body)?.slice(0, 200) ?? 'no body';
}
