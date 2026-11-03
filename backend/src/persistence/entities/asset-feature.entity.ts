import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Per-asset cache of expensive signals (e.g. the iOS screenshot tag).
 * Valid while `checksum` matches the asset's current checksum.
 */
@Entity('asset_feature')
export class AssetFeatureEntity {
  @PrimaryColumn('text')
  assetId: string;

  @Column('text')
  checksum: string;

  /** null = not checked yet / unreadable. */
  @Column('boolean', { nullable: true })
  iosScreenshotTag: boolean | null;

  @Column('datetime')
  checkedAt: Date;
}
