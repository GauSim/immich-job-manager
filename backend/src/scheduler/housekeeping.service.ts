import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { CronJob } from 'cron';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { SqliteService, sqliteNow } from '../persistence/sqlite.service.js';
import { RunQueue } from '../runner/run-queue.js';
import { SettingsService } from '../settings/settings.service.js';

/** Nightly, outside typical schedules (03:00 is popular). */
export const HOUSEKEEPING_CRON = '17 4 * * *';
const VACUUM_EVERY_DAYS = 30;
const DAY_MS = 86_400_000;

export interface HousekeepingResult {
  prunedCandidates: number;
  prunedLogLines: number;
  vacuumed: boolean;
}

/**
 * Keeps the database small (SDD §7): candidates only for the last N dry runs
 * per job, run logs for N days, and a VACUUM about once a month.
 * Run history (totals) and album ownership are never pruned.
 */
@Injectable()
export class Housekeeping
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('Housekeeping');
  private cron?: CronJob;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sqlite: SqliteService,
    private readonly settings: SettingsService,
    private readonly queue: RunQueue,
  ) {}

  onApplicationBootstrap(): void {
    this.cron = CronJob.from({
      cronTime: HOUSEKEEPING_CRON,
      onTick: () => {
        try {
          this.run();
        } catch (e) {
          this.logger.error(`Housekeeping failed: ${(e as Error).message}`);
        }
      },
      start: true,
      timeZone: this.config.tz,
    });
  }

  beforeApplicationShutdown(): void {
    void this.cron?.stop();
  }

  run(now = new Date()): HousekeepingResult {
    const keep = this.settings.get('retention.dryRunCandidates');
    const logDays = this.settings.get('retention.logDays');
    const db = this.sqlite.db;

    const prunedCandidates = db
      .prepare(
        `DELETE FROM run_candidate WHERE run_id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY created_at DESC) AS n
             FROM job_run WHERE dry_run = 1 AND status NOT IN ('queued', 'running')
           ) WHERE n > ?
         )`,
      )
      .run(keep).changes;
    const prunedLogLines = db
      .prepare('DELETE FROM run_log WHERE ts < ?')
      .run(sqliteNow(new Date(now.getTime() - logDays * DAY_MS))).changes;

    let vacuumed = false;
    const last = this.settings.raw('housekeeping.lastVacuumAt') as
      string | undefined;
    const due =
      !last || now.getTime() - Date.parse(last) >= VACUUM_EVERY_DAYS * DAY_MS;
    if (due && this.queue.activeCount === 0) {
      db.exec('VACUUM');
      this.settings.setRaw('housekeeping.lastVacuumAt', now.toISOString());
      vacuumed = true;
    }
    this.logger.log(
      `Pruned ${prunedCandidates} candidate(s) and ${prunedLogLines} log line(s)${vacuumed ? '; database vacuumed' : ''}`,
    );
    return { prunedCandidates, prunedLogLines, vacuumed };
  }
}
