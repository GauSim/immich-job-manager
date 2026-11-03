import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Local copy of the asset metadata that group jobs (trip albums) need, for
 * every image and video in the timeline or archive of the user and of
 * timeline-sharing partners (trip-albums SDD §4). A cache: Immich stays the
 * source of truth, and a full refresh rebuilds it.
 */
@Entity('asset_index')
@Index('idx_asset_index_taken_at', ['takenAt'])
export class AssetIndexEntity {
  @PrimaryColumn('text')
  assetId: string;

  /** Partner assets have another owner than the API key's user. */
  @Column('text')
  ownerId: string;

  /** `IMAGE` / `VIDEO` */
  @Column('text')
  type: string;

  /** `timeline` / `archive` */
  @Column('text')
  visibility: string;

  /**
   * Capture instant (`fileCreatedAt`). Only real when `timeZone` is set;
   * otherwise it is the wall-clock time read as UTC (API notes §10.3).
   */
  @Column('datetime')
  takenAt: Date;

  /** Wall-clock capture time where it was taken, ISO without zone (`2026-03-04T07:20:00.000`). */
  @Column('text')
  localDateTime: string;

  @Column('text', { nullable: true })
  timeZone: string | null;

  @Column('real', { nullable: true })
  latitude: number | null;

  @Column('real', { nullable: true })
  longitude: number | null;

  @Column('text', { nullable: true })
  city: string | null;

  @Column('text', { nullable: true })
  state: string | null;

  @Column('text', { nullable: true })
  country: string | null;

  /** Camera `make` or `model` present (phones count as cameras here). */
  @Column('boolean')
  hasCamera: boolean;

  /** iOS screenshot (`description = "Screenshot"`). */
  @Column('boolean')
  isScreenshot: boolean;

  @Column('text')
  fileName: string;

  /** Immich `updatedAt` of the asset. */
  @Column('datetime')
  immichUpdatedAt: Date;

  /** Start of the refresh that last saw this asset; older rows are deleted when a full refresh completes. */
  @Column('datetime')
  indexedAt: Date;
}
