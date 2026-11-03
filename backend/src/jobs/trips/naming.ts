/** Values for the album name template (trip-albums SDD §5.8). */
export interface NameContext {
  /** Most time spent first. */
  countries: string[];
  /** Most days first. */
  cities: string[];
  /** Local dates `YYYY-MM-DD`. */
  start: string;
  end: string;
  days: number;
}

const SEPARATORS = '\\s\\-–—,:|/·';

/** `Thailand`, `Thailand & Cambodia`, `A, B & C`, `A, B, C +2`. */
export function joinNames(names: string[], max = 3): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length <= max)
    return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
  return `${names.slice(0, max).join(', ')} +${names.length - max}`;
}

function monthName(date: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      timeZone: 'UTC',
    }).format(new Date(`${date}T00:00:00Z`));
  } catch {
    return new Intl.DateTimeFormat('en', {
      month: 'short',
      timeZone: 'UTC',
    }).format(new Date(`${date}T00:00:00Z`));
  }
}

/** `Mar 2026`, `Mar – Apr 2026`, `Dec 2025 – Jan 2026`. */
export function period(start: string, end: string, locale: string): string {
  const [sy, sm] = [start.slice(0, 4), start.slice(5, 7)];
  const [ey, em] = [end.slice(0, 4), end.slice(5, 7)];
  const s = monthName(start, locale);
  const e = monthName(end, locale);
  if (sy === ey && sm === em) return `${s} ${sy}`;
  if (sy === ey) return `${s} – ${e} ${sy}`;
  return `${s} ${sy} – ${e} ${ey}`;
}

/**
 * Renders the album name. Unknown placeholders stay as they are; an empty
 * placeholder disappears together with its separator.
 */
export function renderName(
  template: string,
  ctx: NameContext,
  locale = 'en',
): string {
  const values: Record<string, string> = {
    countries: joinNames(ctx.countries),
    country: ctx.countries[0] ?? '',
    cities: joinNames(ctx.cities),
    period: period(ctx.start, ctx.end, locale),
    year: ctx.start.slice(0, 4),
    month: monthName(ctx.start, locale),
    start: ctx.start,
    end: ctx.end,
    days: String(ctx.days),
  };
  const filled = template.replace(/\{(\w+)\}/g, (m, key: string) =>
    key in values ? `\uE000${values[key]}\uE000` : m,
  );
  // Drop empty placeholders and the separator run next to them.
  const cleaned = filled
    .replace(new RegExp(`[${SEPARATORS}]*\uE000\uE000`, 'g'), '')
    .replace(/\uE000/g, '')
    .replace(new RegExp(`^[${SEPARATORS}]+|[${SEPARATORS}]+$`, 'g'), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned || `Trip ${ctx.start}`;
}
