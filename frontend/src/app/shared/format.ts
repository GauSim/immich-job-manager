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
