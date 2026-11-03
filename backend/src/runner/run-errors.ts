/** Abort reason when a user cancels a run. */
export class RunCancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'RunCancelledError';
  }
}

/** Abort reason on shutdown: the run is resumable. */
export class RunInterruptedError extends Error {
  constructor(reason = 'Interrupted by shutdown') {
    super(reason);
    this.name = 'RunInterruptedError';
  }
}
