import { Global, Injectable, Module } from '@nestjs/common';
import { SqliteService } from '../persistence/sqlite.service.js';

/** Runtime settings (`setting` table) with their defaults (SDD §10: env → database → defaults). */
export const SETTING_DEFAULTS = {
  /** Dry runs per job whose candidates are kept; older ones are pruned nightly. */
  'retention.dryRunCandidates': 5,
  /** Run log lines older than this many days are pruned nightly. */
  'retention.logDays': 30,
  /** Default threshold suggested for new screenshot jobs (UI). */
  'defaults.threshold': 0.6,
} as const;
export type SettingKey = keyof typeof SETTING_DEFAULTS;

/** Small typed key/value store over the `setting` table (synchronous SQLite). */
@Injectable()
export class SettingsService {
  constructor(private readonly sqlite: SqliteService) {}

  get<K extends SettingKey>(key: K): (typeof SETTING_DEFAULTS)[K] {
    return (this.raw(key) ??
      SETTING_DEFAULTS[key]) as (typeof SETTING_DEFAULTS)[K];
  }

  all(): Record<SettingKey, number> {
    return Object.fromEntries(
      (Object.keys(SETTING_DEFAULTS) as SettingKey[]).map((k) => [
        k,
        this.get(k),
      ]),
    ) as Record<SettingKey, number>;
  }

  set(key: SettingKey, value: number): void {
    this.setRaw(key, value);
  }

  /** Internal state (e.g. `housekeeping.lastVacuumAt`), not user settings. */
  raw(key: string): unknown {
    const row = this.sqlite.db
      .prepare('SELECT value FROM setting WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as unknown) : undefined;
  }

  setRaw(key: string, value: unknown): void {
    this.sqlite.db
      .prepare(
        'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
}

@Global()
@Module({ providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
