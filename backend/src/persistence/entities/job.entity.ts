import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const SYNC_MODES = ['dry-run', 'additive', 'mirror'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

/** One configured job: an instance of a job type with params, albums and schedule. */
@Entity('job')
export class JobEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('text')
  name: string;

  @Column('text')
  typeId: string;

  /** Job type version the last full scan used; a bump forces a full rescan. */
  @Column('integer', { default: 0 })
  typeVersion: number;

  @Column('simple-json')
  params: Record<string, unknown>;

  @Column('text', { nullable: true })
  targetAlbumId: string | null;

  @Column('text', { nullable: true })
  exclusionAlbumId: string | null;

  @Column('text', { default: 'dry-run' })
  syncMode: SyncMode;

  /** Cron expression, evaluated in `TZ`. */
  @Column('text', { nullable: true })
  schedule: string | null;

  @Column('boolean', { default: false })
  enabled: boolean;

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt: Date;
}
