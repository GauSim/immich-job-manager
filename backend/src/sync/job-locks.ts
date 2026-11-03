import { Injectable } from '@nestjs/common';

/**
 * In-process locks for work that writes to a job's album outside a run
 * (applying a dry run). Runs check them before starting, and vice versa.
 */
@Injectable()
export class JobLocks {
  private readonly locked = new Set<string>();

  tryLock(jobId: string): boolean {
    if (this.locked.has(jobId)) return false;
    this.locked.add(jobId);
    return true;
  }

  unlock(jobId: string): void {
    this.locked.delete(jobId);
  }

  isLocked(jobId: string): boolean {
    return this.locked.has(jobId);
  }
}
