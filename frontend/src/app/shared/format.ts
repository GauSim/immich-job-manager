/** "3 min ago", "yesterday", … */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const seconds = Math.round((now - parseServerDate(iso).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(-seconds, 'second');
  if (abs < 3600) return rtf.format(-Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(-Math.round(seconds / 3600), 'hour');
  return rtf.format(-Math.round(seconds / 86_400), 'day');
}

/** Duration between two timestamps as `1 m 05 s` / `12.3 s`. */
export function duration(start: string | null, end: string | null, now = Date.now()): string {
  if (!start) return '';
  const ms = (end ? parseServerDate(end).getTime() : now) - parseServerDate(start).getTime();
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} m ${String(s).padStart(2, '0')} s`;
}

/** Server dates are ISO strings; SQLite-style values without zone are UTC. */
export function parseServerDate(iso: string): Date {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
}

/**
 * Local wall-clock range (ISO without zone, e.g. trip `localStart`/`localEnd`)
 * as `4 – 18 Mar 2026`, `28 Mar – 3 Apr 2026` or `28 Dec 2025 – 3 Jan 2026`.
 * The values are not instants: they are formatted as UTC so no zone shifts them.
 */
export function formatLocalRange(start: string, end: string, locale?: string): string {
  const d = (v: string) => new Date(`${v.slice(0, 10)}T00:00:00Z`);
  const s = d(start);
  const e = d(end);
  const fmt = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { ...o, timeZone: 'UTC' });
  if (s.getTime() === e.getTime()) return fmt({ dateStyle: 'medium' }).format(s);
  return fmt({ dateStyle: 'medium' }).formatRange(s, e);
}

/** Local calendar days from `start` to `end` (ISO without zone), inclusive. */
export function localDays(start: string, end: string): number {
  const d = (v: string) => Date.parse(`${v.slice(0, 10)}T00:00:00Z`);
  return Math.round((d(end) - d(start)) / 86_400_000) + 1;
}
