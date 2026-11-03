import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Hand-written (see migrations/index.ts): file name for the review grid, asset lookup for the thumbnail proxy. */
export class CandidateFileName1793718000000 implements MigrationInterface {
  name = 'CandidateFileName1793718000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "run_candidate" ADD COLUMN "original_file_name" text`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_run_candidate_asset" ON "run_candidate" ("asset_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_run_candidate_asset"`);
    await queryRunner.query(
      `ALTER TABLE "run_candidate" DROP COLUMN "original_file_name"`,
    );
  }
}
