import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { JobEntity } from './job.entity.js';

export const RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TRIGGERS = ['manual', 'schedule', 'apply', 'resume'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** One execution of a job. `cursor` makes it resumable. */
@Entity('job_run')
@Index('idx_job_run_job_created', ['jobId', 'createdAt'])
@Index('idx_job_run_status', ['status'])
export class JobRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('text')
  jobId: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: JobEntity;

  @Column('text', { default: 'queued' })
  status: RunStatus;

  @Column('text', { default: 'manual' })
  trigger: RunTrigger;

  @Column('boolean', { default: false })
  dryRun: boolean;

  @Column('boolean', { default: false })
  fullRescan: boolean;

  /** When the run was queued. */
  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date;

  @Column('datetime', { nullable: true })
  startedAt: Date | null;

  @Column('datetime', { nullable: true })
  finishedAt: Date | null;

  /** Incremental runs: only assets updated after this time. */
  @Column('datetime', { nullable: true })
  since: Date | null;

  /** Resume point (Immich `nextCursor` of the last persisted page). */
  @Column('text', { nullable: true })
  cursor: string | null;

  @Column('integer', { default: 0 })
  scanned: number;

  @Column('integer', { default: 0 })
  matched: number;

  @Column('integer', { default: 0 })
  added: number;

  @Column('integer', { default: 0 })
  removed: number;

  @Column('integer', { default: 0 })
  filesRead: number;

  @Column('integer', { default: 0 })
  cacheHits: number;

  @Column('text', { nullable: true })
  error: string | null;

  /** Dry runs: when the selected candidates were last applied to the album. */
  @Column('datetime', { nullable: true })
  appliedAt: Date | null;
}
