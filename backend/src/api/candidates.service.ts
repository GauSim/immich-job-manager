import { ConflictException, Injectable } from '@nestjs/common';
import { SqliteService } from '../persistence/sqlite.service.js';
import type { CandidateQuery, UpdateCandidatesDto } from './dto.js';
import { RunsService } from './runs.service.js';

export interface CandidateView {
  assetId: string;
  score: number;
  reasons: string[];
  originalFileName: string | null;
  selected: boolean;
}

/** Counts for the review grid's filter chips (SDD §9.2). */
export interface CandidateSummary {
  all: number;
  selected: number;
  unselected: number;
  /** score ≥ 0.8 */
  high: number;
  /** score < 0.8 */
  medium: number;
}

export const HIGH_SCORE = 0.8;

const ORDER_BY: Record<CandidateQuery['sort'], string> = {
  '-score': 'score DESC, asset_id',
  score: 'score ASC, asset_id',
  name: 'original_file_name COLLATE NOCASE, asset_id',
};

interface Filter {
  minScore?: number;
  maxScore?: number;
  selected?: boolean;
  group?: string;
}

function where(runId: string, f: Filter): { sql: string; args: unknown[] } {
  const parts = ['run_id = ?'];
  const args: unknown[] = [runId];
  if (f.minScore !== undefined) {
    parts.push('score >= ?');
    args.push(f.minScore);
  }
  if (f.maxScore !== undefined) {
    parts.push('score < ?');
    args.push(f.maxScore);
  }
  if (f.selected !== undefined) {
    parts.push('selected = ?');
    args.push(f.selected ? 1 : 0);
  }
  if (f.group !== undefined) {
    parts.push('group_key = ?');
    args.push(f.group);
  }
  return { sql: parts.join(' AND '), args };
}

/** Dry-run review: list, filter and (un)tick candidates. Reads/writes via SQLite directly (hot path, bulk updates). */
@Injectable()
export class CandidatesService {
  constructor(
    private readonly runs: RunsService,
    private readonly sqlite: SqliteService,
  ) {}

  async list(
    runId: string,
    q: CandidateQuery,
  ): Promise<{
    items: CandidateView[];
    total: number;
    summary: CandidateSummary;
  }> {
    await this.runs.get(runId);
    const w = where(runId, q);
    const db = this.sqlite.db;
    const rows = db
      .prepare(
        `SELECT asset_id, score, reasons, original_file_name, selected FROM run_candidate
         WHERE ${w.sql} ORDER BY ${ORDER_BY[q.sort]} LIMIT ? OFFSET ?`,
      )
      .all(...w.args, q.limit, q.offset) as {
      asset_id: string;
      score: number;
      reasons: string;
      original_file_name: string | null;
      selected: number;
    }[];
    const { total } = db
      .prepare(`SELECT COUNT(*) AS total FROM run_candidate WHERE ${w.sql}`)
      .get(...w.args) as {
      total: number;
    };
    return {
      items: rows.map((r) => ({
        assetId: r.asset_id,
        score: r.score,
        reasons: JSON.parse(r.reasons) as string[],
        originalFileName: r.original_file_name,
        selected: r.selected === 1,
      })),
      total,
      summary: this.summary(runId),
    };
  }

  async update(
    runId: string,
    dto: UpdateCandidatesDto,
  ): Promise<{ updated: number; summary: CandidateSummary }> {
    const run = await this.runs.get(runId);
    if (!run.dryRun)
      throw new ConflictException('Only dry runs have candidates to review');
    const value = dto.selected ? 1 : 0;
    const updated = this.sqlite.transaction((db) => {
      if (dto.assetIds) {
        let n = 0;
        const unique = [...new Set(dto.assetIds)];
        for (let i = 0; i < unique.length; i += 500) {
          const chunk = unique.slice(i, i + 500);
          n += db
            .prepare(
              `UPDATE run_candidate SET selected = ? WHERE run_id = ? AND asset_id IN (${chunk.map(() => '?').join(',')})`,
            )
            .run(value, runId, ...chunk).changes;
        }
        return n;
      }
      const w = where(runId, dto.filter ?? {});
      return db
        .prepare(`UPDATE run_candidate SET selected = ? WHERE ${w.sql}`)
        .run(value, ...w.args).changes;
    });
    return { updated, summary: this.summary(runId) };
  }

  /** True if the asset appeared in any run (thumbnail proxy guard). */
  isKnownAsset(assetId: string): boolean {
    return !!this.sqlite.db
      .prepare('SELECT 1 FROM run_candidate WHERE asset_id = ? LIMIT 1')
      .get(assetId);
  }

  private summary(runId: string): CandidateSummary {
    const row = this.sqlite.db
      .prepare(
        `SELECT COUNT(*) AS all_, COALESCE(SUM(selected), 0) AS selected,
                COALESCE(SUM(score >= ${HIGH_SCORE}), 0) AS high
         FROM run_candidate WHERE run_id = ?`,
      )
      .get(runId) as { all_: number; selected: number; high: number };
    return {
      all: row.all_,
      selected: row.selected,
      unselected: row.all_ - row.selected,
      high: row.high,
      medium: row.all_ - row.high,
    };
  }
}
