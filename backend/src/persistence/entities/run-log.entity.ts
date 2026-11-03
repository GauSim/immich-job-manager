import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { JobRunEntity } from './job-run.entity.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type RunLogLevel = (typeof LOG_LEVELS)[number];

/** Run log lines shown in the UI. */
@Entity('run_log')
@Index('idx_run_log_run', ['runId', 'id'])
@Index('idx_run_log_ts', ['ts'])
export class RunLogEntity {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column('text')
  runId: string;

  @ManyToOne(() => JobRunEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run?: JobRunEntity;

  @Column('datetime')
  ts: Date;

  @Column('text')
  level: RunLogLevel;

  @Column('text')
  message: string;
}
