import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { JobRunEntity } from '../persistence/entities/index.js';
import { RunQueue } from './run-queue.js';

/**
 * Boot: runs left `running` by a crash become `interrupted` (resumable);
 * `queued` runs are queued again in creation order.
 * Shutdown: active runs are interrupted and saved before the DB closes.
 */
@Injectable()
export class RunLifecycle
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('Runner');

  constructor(
    @InjectRepository(JobRunEntity)
    private readonly runs: Repository<JobRunEntity>,
    private readonly queue: RunQueue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const interrupted = await this.runs.update(
      { status: 'running' },
      {
        status: 'interrupted',
        error: 'Interrupted by a restart',
        finishedAt: new Date(),
      },
    );
    if (interrupted.affected)
      this.logger.warn(
        `${interrupted.affected} run(s) were interrupted by a restart; resume them from the run page`,
      );

    const queued = await this.runs.find({
      where: { status: 'queued' },
      order: { createdAt: 'ASC' },
    });
    for (const run of queued) this.queue.enqueue(run.id, run.jobId);
    if (queued.length) this.logger.log(`Re-queued ${queued.length} run(s)`);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.queue.shutdown();
  }
}
