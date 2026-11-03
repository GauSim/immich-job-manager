import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Hand-written (see migrations/index.ts): when a dry run was applied to its album. */
export class RunAppliedAt1793720000000 implements MigrationInterface {
  name = 'RunAppliedAt1793720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "job_run" ADD COLUMN "applied_at" datetime`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "job_run" DROP COLUMN "applied_at"`);
  }
}
