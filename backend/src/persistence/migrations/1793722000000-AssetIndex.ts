import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Hand-written (see migrations/index.ts): local asset metadata index for group jobs (trip albums). */
export class AssetIndex1793722000000 implements MigrationInterface {
  name = 'AssetIndex1793722000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "asset_index" (
                "asset_id" text PRIMARY KEY NOT NULL,
                "owner_id" text NOT NULL,
                "type" text NOT NULL,
                "visibility" text NOT NULL,
                "taken_at" datetime NOT NULL,
                "local_date_time" text NOT NULL,
                "time_zone" text,
                "latitude" real,
                "longitude" real,
                "city" text,
                "state" text,
                "country" text,
                "has_camera" boolean NOT NULL,
                "is_screenshot" boolean NOT NULL,
                "file_name" text NOT NULL,
                "immich_updated_at" datetime NOT NULL,
                "indexed_at" datetime NOT NULL
            )
        `);
    await queryRunner.query(
      `CREATE INDEX "idx_asset_index_taken_at" ON "asset_index" ("taken_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_asset_index_taken_at"`);
    await queryRunner.query(`DROP TABLE "asset_index"`);
  }
}
