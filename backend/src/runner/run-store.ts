import { Injectable } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import type { CandidateBatch } from '../core/job-type.js';
import { SqliteService, sqliteNow } from '../persistence/sqlite.service.js';

export interface RunTotals {
  scanned: number;
  matched: number;
  added: number;
  removed: number;
  filesRead: number;
  cacheHits: number;
}

/** Max ids per `IN (...)` / row batch (well below SQLite's variable limit). */
const CHUNK = 500;

const RETURNING_TOTALS =
  'RETURNING scanned, matched, added, removed, files_read, cache_hits';

function toTotals(
  row: Record<string, number> | undefined,
  runId: string,
): RunTotals {
  if (!row) throw new Error(`Run ${runId} not found`);
  return {
    scanned: row.scanned,
    matched: row.matched,
    added: row.added,
    removed: row.removed,
    filesRead: row.files_read,
    cacheHits: row.cache_hits,
  };
}

function* chunks<T>(items: T[]): Generator<T[]> {
  for (let i = 0; i < items.length; i += CHUNK) yield items.slice(i, i + CHUNK);
}

/**
 * Hot-path persistence for runs. Every method is one synchronous transaction:
 * a page's candidates (dry runs), album ownership, totals and cursor are
 * written together, so a crash never leaves a cursor past unsaved results.
 */
@Injectable()
export class RunStore {
  constructor(private readonly sqlite: SqliteService) {}

  /**
   * Persists one page. `owned` = asset ids this page added to the job's album
   * (real runs); they become `job_asset` ownership rows and count as `added`.
   */
  persistPage(
    runId: string,
    batch: CandidateBatch,
    options: {
      storeCandidates: boolean;
      owned?: { jobId: string; assetIds: string[] };
    },
  ): RunTotals {
    return this.sqlite.transaction((db) => {
      if (options.storeCandidates) {
        // A page may be re-processed after a resume (cursor is at-least-once): upsert.
        const upsert = db.prepare(
          `INSERT INTO run_candidate (run_id, asset_id, score, reasons, original_file_name, selected)
           VALUES (?, ?, ?, ?, ?, 1)
           ON CONFLICT (run_id, asset_id) DO UPDATE SET
             score = excluded.score, reasons = excluded.reasons, original_file_name = excluded.original_file_name`,
        );
        for (const c of batch.candidates) {
          upsert.run(
            runId,
            c.assetId,
            c.score,
            JSON.stringify(c.reasons),
            c.fileName ?? null,
          );
        }
      }
      const added = options.owned
        ? this.insertOwnership(
            db,
            options.owned.jobId,
            runId,
            options.owned.assetIds,
          )
        : 0;
      const row = db
        .prepare(
          `UPDATE job_run SET scanned = scanned + ?, matched = matched + ?, added = added + ?,
             files_read = files_read + ?, cache_hits = cache_hits + ?, cursor = ?
           WHERE id = ? ${RETURNING_TOTALS}`,
        )
        .get(
          batch.scanned,
          batch.candidates.length,
          added,
          batch.filesRead ?? 0,
          batch.cacheHits ?? 0,
          batch.cursor,
          runId,
        ) as Record<string, number> | undefined;
      return toTotals(row, runId);
    });
  }

  /** Group runs: one index page refreshed (adds to `scanned`, saves the cursor). */
  persistIndexPage(
    runId: string,
    scanned: number,
    cursor: string | null,
  ): RunTotals {
    const row = this.sqlite.db
      .prepare(
        `UPDATE job_run SET scanned = scanned + ?, cursor = ? WHERE id = ? ${RETURNING_TOTALS}`,
      )
      .get(scanned, cursor, runId) as Record<string, number> | undefined;
    return toTotals(row, runId);
  }

  /** Sets the cursor only (e.g. a group run's "index complete" marker). */
  setCursor(runId: string, cursor: string | null): void {
    this.sqlite.db
      .prepare('UPDATE job_run SET cursor = ? WHERE id = ?')
      .run(cursor, runId);
  }

  /** Group runs: total assets in the proposed groups. */
  setMatched(runId: string, matched: number): RunTotals {
    const row = this.sqlite.db
      .prepare(
        `UPDATE job_run SET matched = ? WHERE id = ? ${RETURNING_TOTALS}`,
      )
      .get(matched, runId) as Record<string, number> | undefined;
    return toTotals(row, runId);
  }

  /** Group runs / group apply: assets added and removed by the album sync. */
  addSyncTotals(runId: string, added: number, removed: number): RunTotals {
    const row = this.sqlite.db
      .prepare(
        `UPDATE job_run SET added = added + ?, removed = removed + ? WHERE id = ? ${RETURNING_TOTALS}`,
      )
      .get(added, removed, runId) as Record<string, number> | undefined;
    return toTotals(row, runId);
  }

  /** Mirror mode: drops ownership of removed (and vanished) assets; counts `removed`. */
  recordRemovals(
    runId: string,
    jobId: string,
    removed: string[],
    forgotten: string[],
  ): RunTotals {
    return this.sqlite.transaction((db) => {
      for (const ids of chunks([...removed, ...forgotten])) {
        db.prepare(
          `DELETE FROM job_asset WHERE job_id = ? AND asset_id IN (${ids.map(() => '?').join(',')})`,
        ).run(jobId, ...ids);
      }
      const row = db
        .prepare(
          `UPDATE job_run SET removed = removed + ? WHERE id = ? ${RETURNING_TOTALS}`,
        )
        .get(removed.length, runId) as Record<string, number> | undefined;
      return toTotals(row, runId);
    });
  }

  /** Dry-run apply: ownership for the added assets, `added` total and `applied_at`. */
  recordApply(runId: string, jobId: string, added: string[]): RunTotals {
    return this.sqlite.transaction((db) => {
      const n = this.insertOwnership(db, jobId, runId, added);
      const row = db
        .prepare(
          `UPDATE job_run SET added = added + ?, applied_at = ? WHERE id = ? ${RETURNING_TOTALS}`,
        )
        .get(n, sqliteNow(), runId) as Record<string, number> | undefined;
      return toTotals(row, runId);
    });
  }

  /** Assets this job added to its album (mirror mode only ever removes these). */
  ownedAssetIds(jobId: string): string[] {
    return (
      this.sqlite.db
        .prepare('SELECT asset_id FROM job_asset WHERE job_id = ?')
        .all(jobId) as { asset_id: string }[]
    ).map((r) => r.asset_id);
  }

  /** Selected candidates of a dry run. */
  selectedCandidateIds(runId: string): string[] {
    return (
      this.sqlite.db
        .prepare(
          'SELECT asset_id FROM run_candidate WHERE run_id = ? AND selected = 1',
        )
        .all(runId) as { asset_id: string }[]
    ).map((r) => r.asset_id);
  }

  private insertOwnership(
    db: Database,
    jobId: string,
    runId: string,
    assetIds: string[],
  ): number {
    const insert = db.prepare(
      `INSERT INTO job_asset (job_id, asset_id, added_by_run_id, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (job_id, asset_id) DO NOTHING`,
    );
    const now = sqliteNow();
    for (const id of assetIds) insert.run(jobId, id, runId, now);
    return assetIds.length;
  }
}
