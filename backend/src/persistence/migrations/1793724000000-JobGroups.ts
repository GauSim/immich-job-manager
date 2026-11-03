import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hand-written (see migrations/index.ts): groups of group jobs (trip albums
 * SDD §7.1). Constraint names and column types as TypeORM generates them; the
 * new `run_candidate` column is added in place (the generated version rebuilt
 * the table).
 */
export class JobGroups1793724000000 implements MigrationInterface {
  name = 'JobGroups1793724000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "job_group" (
                "id" varchar PRIMARY KEY NOT NULL,
                "job_id" varchar NOT NULL,
                "key" text NOT NULL,
                "status" text NOT NULL DEFAULT ('active'),
                "start_at" datetime NOT NULL,
                "end_at" datetime NOT NULL,
                "core_start_at" datetime NOT NULL,
                "core_end_at" datetime NOT NULL,
                "summary" text NOT NULL,
                "album_id" text,
                "generated_name" text NOT NULL,
                "name_locked" boolean NOT NULL DEFAULT (0),
                "adopted" boolean NOT NULL DEFAULT (0),
                "created_by_run_id" varchar,
                "created_at" datetime NOT NULL DEFAULT (datetime('now')),
                "updated_at" datetime NOT NULL DEFAULT (datetime('now')),
                CONSTRAINT "FK_dd67e961d65631c74c56fad920b" FOREIGN KEY ("job_id") REFERENCES "job" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
                CONSTRAINT "FK_08181b08bf2e2bd6e5c2e1d2e7c" FOREIGN KEY ("created_by_run_id") REFERENCES "job_run" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
            )
        `);
    await queryRunner.query(
      `CREATE INDEX "idx_job_group_job_core" ON "job_group" ("job_id", "core_start_at")`,
    );
    await queryRunner.query(`
            CREATE TABLE "job_group_asset" (
                "group_id" varchar NOT NULL,
                "asset_id" text NOT NULL,
                "state" text NOT NULL,
                "run_id" text,
                "changed_at" datetime NOT NULL,
                CONSTRAINT "FK_7e20ab0f89e46f7f5b5ad0eb85c" FOREIGN KEY ("group_id") REFERENCES "job_group" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
                PRIMARY KEY ("group_id", "asset_id")
            )
        `);
    await queryRunner.query(
      `CREATE INDEX "idx_job_group_asset_asset" ON "job_group_asset" ("asset_id")`,
    );
    await queryRunner.query(`
            CREATE TABLE "run_group" (
                "run_id" varchar NOT NULL,
                "group_key" text NOT NULL,
                "action" text NOT NULL,
                "job_group_id" varchar,
                "album_id" text,
                "name" text NOT NULL,
                "start_at" datetime NOT NULL,
                "end_at" datetime NOT NULL,
                "core_start_at" datetime NOT NULL,
                "core_end_at" datetime NOT NULL,
                "ongoing" boolean NOT NULL DEFAULT (0),
                "summary" text NOT NULL,
                "asset_count" integer NOT NULL DEFAULT (0),
                "selected" boolean NOT NULL DEFAULT (1),
                CONSTRAINT "FK_53301f35d1a6e5bc367f12a1130" FOREIGN KEY ("run_id") REFERENCES "job_run" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
                CONSTRAINT "FK_ff30209a29372f1188c30f048a1" FOREIGN KEY ("job_group_id") REFERENCES "job_group" ("id") ON DELETE SET NULL ON UPDATE NO ACTION,
                PRIMARY KEY ("run_id", "group_key")
            )
        `);
    await queryRunner.query(
      `ALTER TABLE "run_candidate" ADD COLUMN "group_key" text`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_run_candidate_run_group" ON "run_candidate" ("run_id", "group_key")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_run_candidate_run_group"`);
    await queryRunner.query(
      `ALTER TABLE "run_candidate" DROP COLUMN "group_key"`,
    );
    await queryRunner.query(`DROP TABLE "run_group"`);
    await queryRunner.query(`DROP INDEX "idx_job_group_asset_asset"`);
    await queryRunner.query(`DROP TABLE "job_group_asset"`);
    await queryRunner.query(`DROP INDEX "idx_job_group_job_core"`);
    await queryRunner.query(`DROP TABLE "job_group"`);
  }
}
