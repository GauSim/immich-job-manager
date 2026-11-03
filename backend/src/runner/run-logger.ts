import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { RunLogger } from '../core/job-type.js';
import type { RunEventsService } from '../events/run-events.service.js';
import type {
  RunLogEntity,
  RunLogLevel,
} from '../persistence/entities/index.js';

/**
 * Writes run log lines to `run_log` (for the UI), the live event stream and
 * the app log. DB writes are chained to keep order; `flush()` awaits them.
 */
export class DbRunLogger implements RunLogger {
  private static readonly appLogger = new Logger('Run');
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly runId: string,
    private readonly logs: Repository<RunLogEntity>,
    private readonly events: RunEventsService,
  ) {}

  debug(message: string): void {
    this.write('debug', message);
  }
  info(message: string): void {
    this.write('info', message);
  }
  warn(message: string): void {
    this.write('warn', message);
  }
  error(message: string): void {
    this.write('error', message);
  }

  flush(): Promise<unknown> {
    return this.pending;
  }

  private write(level: RunLogLevel, message: string): void {
    const ts = new Date();
    this.events.log(this.runId, level, message, ts);
    const line = `[run ${this.runId}] ${message}`;
    if (level === 'error') DbRunLogger.appLogger.error(line);
    else if (level === 'warn') DbRunLogger.appLogger.warn(line);
    else if (level === 'debug') DbRunLogger.appLogger.debug(line);
    else DbRunLogger.appLogger.log(line);
    this.pending = this.pending
      .then(() => this.logs.insert({ runId: this.runId, ts, level, message }))
      .catch((e: Error) =>
        DbRunLogger.appLogger.error(`Cannot write run log: ${e.message}`),
      );
  }
}
