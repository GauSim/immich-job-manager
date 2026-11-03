import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hand-written: TypeORM generates a table rebuild for SQLite here, and
 * dropping `job` would cascade-delete its runs. ADD COLUMN keeps all rows.
 */
export class JobAlbumNames1793715748738 implements MigrationInterface {
  name = 'JobAlbumNames1793715748738';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "job" ADD COLUMN "target_album_name" text NOT NULL DEFAULT ('')`,
    );
    await queryRunner.query(
      `ALTER TABLE "job" ADD COLUMN "exclusion_album_name" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "job" DROP COLUMN "exclusion_album_name"`,
    );
    await queryRunner.query(
      `ALTER TABLE "job" DROP COLUMN "target_album_name"`,
    );
  }
}
