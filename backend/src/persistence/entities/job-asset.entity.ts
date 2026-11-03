import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { JobRunEntity } from './job-run.entity.js';
import { JobEntity } from './job.entity.js';

/**
 * Ownership: an asset this app added to the job's target album.
 * Mirror mode only ever removes assets found here. The primary key
 * (job_id, asset_id) doubles as the lookup index.
 */
@Entity('job_asset')
export class JobAssetEntity {
  @PrimaryColumn('text')
  jobId: string;

  @PrimaryColumn('text')
  assetId: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: JobEntity;

  @Column('text', { nullable: true })
  addedByRunId: string | null;

  @ManyToOne(() => JobRunEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'added_by_run_id' })
  addedByRun?: JobRunEntity;

  @Column('datetime')
  addedAt: Date;
}
