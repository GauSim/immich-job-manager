import { Injectable } from '@nestjs/common';
import type { Statement } from 'better-sqlite3';
import type { CandidateBatch } from '../core/job-type.js';
import { SqliteService } from '../persistence/sqlite.service.js';

export interface RunTotals {
  scanned: number;
  matched: number;
  added: number;
  removed: number;
  filesRead: number;
  cacheHits: number;
}

/** Max candidate rows per INSERT statement batch inside one page transaction. */
const CANDIDATE_INSERT_CHUNK = 500;

/**
 * Hot-path persistence for the runner. One page = one synchronous transaction:
 * candidates (dry runs), totals and cursor are written together, so a crash
 * never leaves a cursor that points past unsaved results.
 */
@Injectable()
export class RunStore {
  private statements?: {
    upsertCandidate: Statement;
    updateTotals: Statement;
  };

  constructor(private readonly sqlite: SqliteService) {}

  persistPage(
    runId: string,
    batch: CandidateBatch,
    options: { storeCandidates: boolean },
  ): RunTotals {
    const s = this.prepare();
    return this.sqlite.transaction(() => {
      if (options.storeCandidates) {
        for (
          let i = 0;
          i < batch.candidates.length;
          i += CANDIDATE_INSERT_CHUNK
        ) {
          for (const c of batch.candidates.slice(
            i,
            i + CANDIDATE_INSERT_CHUNK,
          )) {
            s.upsertCandidate.run(
              runId,
              c.assetId,
              c.score,
              JSON.stringify(c.reasons),
              c.fileName ?? null,
            );
          }
        }
      }
      const row = s.updateTotals.get(
        batch.scanned,
        batch.candidates.length,
        batch.filesRead ?? 0,
        batch.cacheHits ?? 0,
        batch.cursor,
        runId,
      ) as Record<string, number> | undefined;
      if (!row) throw new Error(`Run ${runId} not found`);
      return {
        scanned: row.scanned,
        matched: row.matched,
        added: row.added,
        removed: row.removed,
        filesRead: row.files_read,
        cacheHits: row.cache_hits,
      };
    });
  }

  private prepare() {
    if (this.statements) return this.statements;
    const db = this.sqlite.db;
    this.statements = {
      // A page may be re-processed after a resume (cursor is at-least-once): upsert.
      upsertCandidate: db.prepare(
        `INSERT INTO run_candidate (run_id, asset_id, score, reasons, original_file_name, selected)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT (run_id, asset_id) DO UPDATE SET
           score = excluded.score, reasons = excluded.reasons, original_file_name = excluded.original_file_name`,
      ),
      updateTotals: db.prepare(
        `UPDATE job_run SET scanned = scanned + ?, matched = matched + ?, files_read = files_read + ?,
           cache_hits = cache_hits + ?, cursor = ?
         WHERE id = ?
         RETURNING scanned, matched, added, removed, files_read, cache_hits`,
      ),
    };
    return this.statements;
  }
}
