import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import type { Repository } from 'typeorm';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { JobEntity } from '../persistence/entities/index.js';
import { RunLauncher } from '../runner/run-launcher.js';

export type TriggerOutcome = 'started' | 'skipped' | 'not-scheduled' | 'failed';

/**
 * Runs enabled jobs on their cron schedule, in the configured time zone
 * (`TZ`). Registered on boot and re-registered whenever a job changes.
 * A trigger is skipped while the job already has an active run.
 */
@Injectable()
export class JobScheduler
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('Scheduler');
  private readonly crons = new Map<string, CronJob>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectRepository(JobEntity) private readonly jobs: Repository<JobEntity>,
    private readonly launcher: RunLauncher,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const job of await this.jobs.find()) this.sync(job);
    if (this.crons.size)
      this.logger.log(
        `${this.crons.size} scheduled job(s), time zone ${this.config.tz}`,
      );
  }

  beforeApplicationShutdown(): void {
    for (const cron of this.crons.values()) void cron.stop();
    this.crons.clear();
  }

  /** (Re-)registers a job after create/update; removes it when disabled or unscheduled. */
  sync(job: JobEntity): void {
    this.remove(job.id);
    if (!job.enabled || !job.schedule) return;
    const cron = CronJob.from({
      cronTime: job.schedule,
      onTick: () => void this.trigger(job.id),
      start: true,
      timeZone: this.config.tz,
    });
    this.crons.set(job.id, cron);
  }

  remove(jobId: string): void {
    void this.crons.get(jobId)?.stop();
    this.crons.delete(jobId);
  }

  isScheduled(jobId: string): boolean {
    return this.crons.has(jobId);
  }

  nextRun(jobId: string): Date | null {
    return this.crons.get(jobId)?.nextDate().toJSDate() ?? null;
  }

  /** One scheduled trigger: starts a run unless the job is busy. */
  async trigger(jobId: string): Promise<TriggerOutcome> {
    const job = await this.jobs.findOneBy({ id: jobId });
    if (!job?.enabled || !job.schedule) return 'not-scheduled';
    try {
      const { runId, plan } = this.launcher.launch(job, {
        trigger: 'schedule',
      });
      this.logger.log(
        `Started scheduled ${plan.dryRun ? 'dry run' : 'run'} ${runId} of "${job.name}" (${plan.reason})`,
      );
      return 'started';
    } catch (e) {
      if (e instanceof ConflictException) {
        this.logger.warn(
          `Skipped scheduled run of "${job.name}": ${e.message}`,
        );
        return 'skipped';
      }
      this.logger.error(
        `Scheduled run of "${job.name}" failed to start: ${(e as Error).message}`,
      );
      return 'failed';
    }
  }
}
