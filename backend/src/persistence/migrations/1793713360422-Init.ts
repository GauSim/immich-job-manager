import { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1793713360422 implements MigrationInterface {
  name = 'Init1793713360422';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "asset_feature" (
                "asset_id" text PRIMARY KEY NOT NULL,
                "checksum" text NOT NULL,
                "ios_screenshot_tag" boolean,
                "checked_at" datetime NOT NULL
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "job" (
                "id" varchar PRIMARY KEY NOT NULL,
                "name" text NOT NULL,
                "type_id" text NOT NULL,
                "type_version" integer NOT NULL DEFAULT (0),
                "params" text NOT NULL,
                "target_album_id" text,
                "exclusion_album_id" text,
                "sync_mode" text NOT NULL DEFAULT ('dry-run'),
                "schedule" text,
                "enabled" boolean NOT NULL DEFAULT (0),
                "created_at" datetime NOT NULL DEFAULT (datetime('now')),
                "updated_at" datetime NOT NULL DEFAULT (datetime('now'))
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "job_run" (
                "id" varchar PRIMARY KEY NOT NULL,
                "job_id" varchar NOT NULL,
                "status" text NOT NULL DEFAULT ('queued'),
                "trigger" text NOT NULL DEFAULT ('manual'),
                "dry_run" boolean NOT NULL DEFAULT (0),
                "full_rescan" boolean NOT NULL DEFAULT (0),
                "created_at" datetime NOT NULL DEFAULT (datetime('now')),
                "started_at" datetime,
                "finished_at" datetime,
                "since" datetime,
                "cursor" text,
                "scanned" integer NOT NULL DEFAULT (0),
                "matched" integer NOT NULL DEFAULT (0),
                "added" integer NOT NULL DEFAULT (0),
                "removed" integer NOT NULL DEFAULT (0),
                "files_read" integer NOT NULL DEFAULT (0),
                "cache_hits" integer NOT NULL DEFAULT (0),
                "error" text
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_job_run_status" ON "job_run" ("status")
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_job_run_job_created" ON "job_run" ("job_id", "created_at")
        `);
    await queryRunner.query(`
            CREATE TABLE "job_asset" (
                "job_id" varchar NOT NULL,
                "asset_id" text NOT NULL,
                "added_by_run_id" varchar,
                "added_at" datetime NOT NULL,
                PRIMARY KEY ("job_id", "asset_id")
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "run_candidate" (
                "run_id" varchar NOT NULL,
                "asset_id" text NOT NULL,
                "score" real NOT NULL,
                "reasons" text NOT NULL,
                "selected" boolean NOT NULL DEFAULT (1),
                PRIMARY KEY ("run_id", "asset_id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_run_candidate_run_score" ON "run_candidate" ("run_id", "score")
        `);
    await queryRunner.query(`
            CREATE TABLE "run_log" (
                "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                "run_id" varchar NOT NULL,
                "ts" datetime NOT NULL,
                "level" text NOT NULL,
                "message" text NOT NULL
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_run_log_ts" ON "run_log" ("ts")
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_run_log_run" ON "run_log" ("run_id", "id")
        `);
    await queryRunner.query(`
            CREATE TABLE "setting" (
                "key" text PRIMARY KEY NOT NULL,
                "value" text NOT NULL
            )
        `);
    await queryRunner.query(`
            DROP INDEX "idx_job_run_status"
        `);
    await queryRunner.query(`
            DROP INDEX "idx_job_run_job_created"
        `);
    await queryRunner.query(`
            CREATE TABLE "temporary_job_run" (
                "id" varchar PRIMARY KEY NOT NULL,
                "job_id" varchar NOT NULL,
                "status" text NOT NULL DEFAULT ('queued'),
                "trigger" text NOT NULL DEFAULT ('manual'),
                "dry_run" boolean NOT NULL DEFAULT (0),
                "full_rescan" boolean NOT NULL DEFAULT (0),
                "created_at" datetime NOT NULL DEFAULT (datetime('now')),
                "started_at" datetime,
                "finished_at" datetime,
                "since" datetime,
                "cursor" text,
                "scanned" integer NOT NULL DEFAULT (0),
                "matched" integer NOT NULL DEFAULT (0),
                "added" integer NOT NULL DEFAULT (0),
                "removed" integer NOT NULL DEFAULT (0),
                "files_read" integer NOT NULL DEFAULT (0),
                "cache_hits" integer NOT NULL DEFAULT (0),
                "error" text,
                CONSTRAINT "FK_327474b5fb1aa6827f55ce90e6f" FOREIGN KEY ("job_id") REFERENCES "job" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
            )
        `);
    await queryRunner.query(`
            INSERT INTO "temporary_job_run"(
                    "id",
                    "job_id",
                    "status",
                    "trigger",
                    "dry_run",
                    "full_rescan",
                    "created_at",
                    "started_at",
                    "finished_at",
                    "since",
                    "cursor",
                    "scanned",
                    "matched",
                    "added",
                    "removed",
                    "files_read",
                    "cache_hits",
                    "error"
                )
            SELECT "id",
                "job_id",
                "status",
                "trigger",
                "dry_run",
                "full_rescan",
                "created_at",
                "started_at",
                "finished_at",
                "since",
                "cursor",
                "scanned",
                "matched",
                "added",
                "removed",
                "files_read",
                "cache_hits",
                "error"
            FROM "job_run"
        `);
    await queryRunner.query(`
            DROP TABLE "job_run"
        `);
    await queryRunner.query(`
            ALTER TABLE "temporary_job_run"
                RENAME TO "job_run"
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_job_run_status" ON "job_run" ("status")
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_job_run_job_created" ON "job_run" ("job_id", "created_at")
        `);
    await queryRunner.query(`
            CREATE TABLE "temporary_job_asset" (
                "job_id" varchar NOT NULL,
                "asset_id" text NOT NULL,
                "added_by_run_id" varchar,
                "added_at" datetime NOT NULL,
                CONSTRAINT "FK_d5677f564b6ce04413864464d4b" FOREIGN KEY ("job_id") REFERENCES "job" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
                CONSTRAINT "FK_1459b2c6e6e0898b9fa6dec0488" FOREIGN KEY ("added_by_run_id") REFERENCES "job_run" ("id") ON DELETE
                SET NULL ON UPDATE NO ACTION,
                    PRIMARY KEY ("job_id", "asset_id")
            )
        `);
    await queryRunner.query(`
            INSERT INTO "temporary_job_asset"(
                    "job_id",
                    "asset_id",
                    "added_by_run_id",
                    "added_at"
                )
            SELECT "job_id",
                "asset_id",
                "added_by_run_id",
                "added_at"
            FROM "job_asset"
        `);
    await queryRunner.query(`
            DROP TABLE "job_asset"
        `);
    await queryRunner.query(`
            ALTER TABLE "temporary_job_asset"
                RENAME TO "job_asset"
        `);
    await queryRunner.query(`
            DROP INDEX "idx_run_candidate_run_score"
        `);
    await queryRunner.query(`
            CREATE TABLE "temporary_run_candidate" (
                "run_id" varchar NOT NULL,
                "asset_id" text NOT NULL,
                "score" real NOT NULL,
                "reasons" text NOT NULL,
                "selected" boolean NOT NULL DEFAULT (1),
                CONSTRAINT "FK_11cb6b4a8f7aa64e0dd59443aea" FOREIGN KEY ("run_id") REFERENCES "job_run" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
                PRIMARY KEY ("run_id", "asset_id")
            )
        `);
    await queryRunner.query(`
            INSERT INTO "temporary_run_candidate"(
                    "run_id",
                    "asset_id",
                    "score",
                    "reasons",
                    "selected"
                )
            SELECT "run_id",
                "asset_id",
                "score",
                "reasons",
                "selected"
            FROM "run_candidate"
        `);
    await queryRunner.query(`
            DROP TABLE "run_candidate"
        `);
    await queryRunner.query(`
            ALTER TABLE "temporary_run_candidate"
                RENAME TO "run_candidate"
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_run_candidate_run_score" ON "run_candidate" ("run_id", "score")
        `);
    await queryRunner.query(`
            DROP INDEX "idx_run_log_ts"
        `);
    await queryRunner.query(`
            DROP INDEX "idx_run_log_run"
        `);
    await queryRunner.query(`
            CREATE TABLE "temporary_run_log" (
                "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                "run_id" varchar NOT NULL,
                "ts" datetime NOT NULL,
                "level" text NOT NULL,
                "message" text NOT NULL,
                CONSTRAINT "FK_648fc52b815cb96b7dc740b4978" FOREIGN KEY ("run_id") REFERENCES "job_run" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
            )
        `);
    await queryRunner.query(`
            INSERT INTO "temporary_run_log"("id", "run_id", "ts", "level", "message")
            SELECT "id",
                "run_id",
                "ts",
                "level",
                "message"
            FROM "run_log"
        `);
    await queryRunner.query(`
            DROP TABLE "run_log"
        `);
    await queryRunner.query(`
            ALTER TABLE "temporary_run_log"
                RENAME TO "run_log"
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_run_log_ts" ON "run_log" ("ts")
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_run_log_run" ON "run_log" ("run_id", "id")
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX "idx_run_log_run"
        `);
    await queryRunner.query(`
            DROP INDEX "idx_run_log_ts"
        `);
    await queryRunner.query(`
            ALTER TABLE "run_log"
                RENAME TO "temporary_run_log"
        `);
    await queryRunner.query(`
            CREATE TABLE "run_log" (
                "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                "run_id" varchar NOT NULL,
                "ts" datetime NOT NULL,
                "level" text NOT NULL,
                "message" text NOT NULL
            )
        `);
    await queryRunner.query(`
            INSERT INTO "run_log"("id", "run_id", "ts", "level", "message")
            SELECT "id",
                "run_id",
                "ts",
                "level",
                "message"
            FROM "temporary_run_log"
        `);
    await queryRunner.query(`
            DROP TABLE "temporary_run_log"
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_run_log_run" ON "run_log" ("run_id", "id")
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_run_log_ts" ON "run_log" ("ts")
        `);
    await queryRunner.query(`
            DROP INDEX "idx_run_candidate_run_score"
        `);
    await queryRunner.query(`
            ALTER TABLE "run_candidate"
                RENAME TO "temporary_run_candidate"
        `);
    await queryRunner.query(`
            CREATE TABLE "run_candidate" (
                "run_id" varchar NOT NULL,
                "asset_id" text NOT NULL,
                "score" real NOT NULL,
                "reasons" text NOT NULL,
                "selected" boolean NOT NULL DEFAULT (1),
                PRIMARY KEY ("run_id", "asset_id")
            )
        `);
    await queryRunner.query(`
            INSERT INTO "run_candidate"(
                    "run_id",
                    "asset_id",
                    "score",
                    "reasons",
                    "selected"
                )
            SELECT "run_id",
                "asset_id",
                "score",
                "reasons",
                "selected"
            FROM "temporary_run_candidate"
        `);
    await queryRunner.query(`
            DROP TABLE "temporary_run_candidate"
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_run_candidate_run_score" ON "run_candidate" ("run_id", "score")
        `);
    await queryRunner.query(`
            ALTER TABLE "job_asset"
                RENAME TO "temporary_job_asset"
        `);
    await queryRunner.query(`
            CREATE TABLE "job_asset" (
                "job_id" varchar NOT NULL,
                "asset_id" text NOT NULL,
                "added_by_run_id" varchar,
                "added_at" datetime NOT NULL,
                PRIMARY KEY ("job_id", "asset_id")
            )
        `);
    await queryRunner.query(`
            INSERT INTO "job_asset"(
                    "job_id",
                    "asset_id",
                    "added_by_run_id",
                    "added_at"
                )
            SELECT "job_id",
                "asset_id",
                "added_by_run_id",
                "added_at"
            FROM "temporary_job_asset"
        `);
    await queryRunner.query(`
            DROP TABLE "temporary_job_asset"
        `);
    await queryRunner.query(`
            DROP INDEX "idx_job_run_job_created"
        `);
    await queryRunner.query(`
            DROP INDEX "idx_job_run_status"
        `);
    await queryRunner.query(`
            ALTER TABLE "job_run"
                RENAME TO "temporary_job_run"
        `);
    await queryRunner.query(`
            CREATE TABLE "job_run" (
                "id" varchar PRIMARY KEY NOT NULL,
                "job_id" varchar NOT NULL,
                "status" text NOT NULL DEFAULT ('queued'),
                "trigger" text NOT NULL DEFAULT ('manual'),
                "dry_run" boolean NOT NULL DEFAULT (0),
                "full_rescan" boolean NOT NULL DEFAULT (0),
                "created_at" datetime NOT NULL DEFAULT (datetime('now')),
                "started_at" datetime,
                "finished_at" datetime,
                "since" datetime,
                "cursor" text,
                "scanned" integer NOT NULL DEFAULT (0),
                "matched" integer NOT NULL DEFAULT (0),
                "added" integer NOT NULL DEFAULT (0),
                "removed" integer NOT NULL DEFAULT (0),
                "files_read" integer NOT NULL DEFAULT (0),
                "cache_hits" integer NOT NULL DEFAULT (0),
                "error" text
            )
        `);
    await queryRunner.query(`
            INSERT INTO "job_run"(
                    "id",
                    "job_id",
                    "status",
                    "trigger",
                    "dry_run",
                    "full_rescan",
                    "created_at",
                    "started_at",
                    "finished_at",
                    "since",
                    "cursor",
                    "scanned",
                    "matched",
                    "added",
                    "removed",
                    "files_read",
                    "cache_hits",
                    "error"
                )
            SELECT "id",
                "job_id",
                "status",
                "trigger",
                "dry_run",
                "full_rescan",
                "created_at",
                "started_at",
                "finished_at",
                "since",
                "cursor",
                "scanned",
                "matched",
                "added",
                "removed",
                "files_read",
                "cache_hits",
                "error"
            FROM "temporary_job_run"
        `);
    await queryRunner.query(`
            DROP TABLE "temporary_job_run"
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_job_run_job_created" ON "job_run" ("job_id", "created_at")
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_job_run_status" ON "job_run" ("status")
        `);
    await queryRunner.query(`
            DROP TABLE "setting"
        `);
    await queryRunner.query(`
            DROP INDEX "idx_run_log_run"
        `);
    await queryRunner.query(`
            DROP INDEX "idx_run_log_ts"
        `);
    await queryRunner.query(`
            DROP TABLE "run_log"
        `);
    await queryRunner.query(`
            DROP INDEX "idx_run_candidate_run_score"
        `);
    await queryRunner.query(`
            DROP TABLE "run_candidate"
        `);
    await queryRunner.query(`
            DROP TABLE "job_asset"
        `);
    await queryRunner.query(`
            DROP INDEX "idx_job_run_job_created"
        `);
    await queryRunner.query(`
            DROP INDEX "idx_job_run_status"
        `);
    await queryRunner.query(`
            DROP TABLE "job_run"
        `);
    await queryRunner.query(`
            DROP TABLE "job"
        `);
    await queryRunner.query(`
            DROP TABLE "asset_feature"
        `);
  }
}
