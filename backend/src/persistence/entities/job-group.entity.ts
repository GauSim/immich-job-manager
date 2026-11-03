import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { JobRunEntity } from './job-run.entity.js';
import { JobEntity } from './job.entity.js';

export const GROUP_STATUSES = [
  'active',
  'ongoing',
  'ignored',
  'orphaned',
  'merged',
  'locked',
] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];

/**
 * One group of a group job (e.g. a trip) and its Immich album
 * (trip-albums SDD §7.1). Created by real runs / apply (T4).
 */
@Entity('job_group')
@Index('idx_job_group_job_core', ['jobId', 'coreStartAt'])
export class JobGroupEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('text')
  jobId: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: JobEntity;

  /** Key of the proposal it was last matched to (e.g. `trip:2026-03-04`). */
  @Column('text')
  key: string;

  @Column('text', { default: 'active' })
  status: GroupStatus;

  @Column('datetime')
  startAt: Date;

  @Column('datetime')
  endAt: Date;

  @Column('datetime')
  coreStartAt: Date;

  @Column('datetime')
  coreEndAt: Date;

  @Column('simple-json')
  summary: Record<string, unknown>;

  @Column('text', { nullable: true })
  albumId: string | null;

  /** Name the job gave the album; a different album name means the user renamed it. */
  @Column('text')
  generatedName: string;

  /** Renamed by the user (or adopted): never renamed by the job. */
  @Column('boolean', { default: false })
  nameLocked: boolean;

  /** An existing album the job took over: only adds, never removes or renames. */
  @Column('boolean', { default: false })
  adopted: boolean;

  @Column('text', { nullable: true })
  createdByRunId: string | null;

  @ManyToOne(() => JobRunEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by_run_id' })
  createdByRun?: JobRunEntity;

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt: Date;
}

export const GROUP_ASSET_STATES = ['owned', 'present', 'excluded'] as const;
export type GroupAssetState = (typeof GROUP_ASSET_STATES)[number];

/**
 * Membership of a group's album as the job knows it: `owned` (added by the
 * job), `present` (in the album, not added by the job), `excluded` (removed
 * by hand → never re-added).
 */
@Entity('job_group_asset')
@Index('idx_job_group_asset_asset', ['assetId'])
export class JobGroupAssetEntity {
  @PrimaryColumn('text')
  groupId: string;

  @PrimaryColumn('text')
  assetId: string;

  @ManyToOne(() => JobGroupEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'group_id' })
  group?: JobGroupEntity;

  @Column('text')
  state: GroupAssetState;

  @Column('text', { nullable: true })
  runId: string | null;

  @Column('datetime')
  changedAt: Date;
}

export const GROUP_ACTIONS = [
  'create',
  'update',
  'ignored',
  'locked',
  'orphaned',
  'merged',
] as const;
export type GroupAction = (typeof GROUP_ACTIONS)[number];

/** Dry runs only: a proposed (or affected existing) group for the review list. */
@Entity('run_group')
export class RunGroupEntity {
  @PrimaryColumn('text')
  runId: string;

  /** Proposal key, or `group:<id>` for existing groups without a proposal. */
  @PrimaryColumn('text')
  groupKey: string;

  @ManyToOne(() => JobRunEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run?: JobRunEntity;

  @Column('text')
  action: GroupAction;

  /** Matched existing group, if any. */
  @Column('text', { nullable: true })
  jobGroupId: string | null;

  @ManyToOne(() => JobGroupEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'job_group_id' })
  jobGroup?: JobGroupEntity;

  @Column('text', { nullable: true })
  albumId: string | null;

  @Column('text')
  name: string;

  @Column('datetime')
  startAt: Date;

  @Column('datetime')
  endAt: Date;

  @Column('datetime')
  coreStartAt: Date;

  @Column('datetime')
  coreEndAt: Date;

  @Column('boolean', { default: false })
  ongoing: boolean;

  @Column('simple-json')
  summary: Record<string, unknown>;

  @Column('integer', { default: 0 })
  assetCount: number;

  /** Unticked in the review → not applied (and remembered as ignored on apply, T4). */
  @Column('boolean', { default: true })
  selected: boolean;
}
