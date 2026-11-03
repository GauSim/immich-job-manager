import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { JobRunEntity } from './job-run.entity.js';

/** Dry runs only: a candidate asset with its score, for the review grid. */
@Entity('run_candidate')
@Index('idx_run_candidate_run_score', ['runId', 'score'])
@Index('idx_run_candidate_asset', ['assetId'])
@Index('idx_run_candidate_run_group', ['runId', 'groupKey'])
export class RunCandidateEntity {
  @PrimaryColumn('text')
  runId: string;

  @PrimaryColumn('text')
  assetId: string;

  @ManyToOne(() => JobRunEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run?: JobRunEntity;

  @Column('real')
  score: number;

  @Column('simple-json')
  reasons: string[];

  /** For display in the review grid. */
  @Column('text', { nullable: true })
  originalFileName: string | null;

  /** Group jobs: key of the proposed group (e.g. trip) the asset belongs to. */
  @Column('text', { nullable: true })
  groupKey: string | null;

  /** Unticked in the review grid → not applied. */
  @Column('boolean', { default: true })
  selected: boolean;
}
