import type { IndexedAsset } from '../../asset-index/asset-index.mapping.js';
import { isAway } from './away.js';
import { dayString, hasGps, localAt, localDayNumber } from './geo-time.js';
import { HomeModel } from './home.js';
import { renderName } from './naming.js';
import { segment, type Segment } from './segment.js';
import { arrival, departure, type Boundary } from './transit.js';
import type { TripParams } from './trip.params.js';

/** Why an asset is in a trip. */
export type TripReason =
  | 'gps-away'
  | 'gps-in-range'
  | 'transit-departure'
  | 'transit-return'
  | 'no-gps-camera'
  | 'no-gps'
  | 'partner';

export interface TripAsset {
  assetId: string;
  reasons: TripReason[];
}

export interface DetectedTrip {
  /** Deterministic, from the local start date: `trip:2026-03-03`. */
  key: string;
  /** Trip range (incl. travel days), instants in ms, inclusive. */
  start: number;
  end: number;
  /** Same range as local wall-clock time (ISO, no zone). */
  localStart: string;
  localEnd: string;
  /** First / last away point (used to match trips across runs). */
  coreStart: number;
  coreEnd: number;
  ongoing: boolean;
  /** How start and end were found. */
  startRule: Boundary['rule'];
  endRule: Boundary['rule'];
  countries: string[];
  cities: string[];
  /** Local calendar days from start to end. */
  days: number;
  name: string;
  assets: TripAsset[];
}

export interface DroppedSegment {
  localStart: string;
  localEnd: string;
  countries: string[];
  awayAssets: number;
  reason: 'too-short' | 'too-few-assets' | 'too-long' | 'before-minimum-year';
}

export interface DetectInput {
  /** All index rows the job reads (`AssetIndexReader.all()`), own and partner. */
  assets: readonly IndexedAsset[];
  /** The user's id; other owners are partners. */
  ownerId: string;
  params: TripParams;
  now: Date;
}

export interface DetectResult {
  trips: DetectedTrip[];
  dropped: DroppedSegment[];
  home: HomeModel;
}

interface Range {
  segment: Segment;
  /** Index of the first / last away point in `gps`. */
  first: number;
  last: number;
  start: Boundary;
  end: Boundary;
  ongoing: boolean;
}

const byInstant = (a: IndexedAsset, b: IndexedAsset) =>
  a.takenAt - b.takenAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Finds trips in the index (trip-albums SDD §5). Pure and deterministic: the
 * same input gives the same trips, whatever the order of `assets`.
 */
export function detectTrips(input: DetectInput): DetectResult {
  const { params, ownerId } = input;
  const adv = params.advanced;
  const now = input.now.getTime();

  const assets = input.assets
    .filter((a) => params.includeVideos || a.type !== 'VIDEO')
    .filter((a) => a.ownerId === ownerId || params.partnerAssets !== 'off')
    .slice()
    .sort(byInstant);

  const own = assets.filter((a) => a.ownerId === ownerId);
  const home = new HomeModel(own, adv.homeWindowDays);
  const away = (a: IndexedAsset) => isAway(a, home, params);

  // Trips are established by own GPS points (and partners' with `full`).
  const gps = assets.filter(
    (a) =>
      hasGps(a) && (a.ownerId === ownerId || params.partnerAssets === 'full'),
  );
  const indexOf = new Map(gps.map((a, i) => [a.id, i]));
  const segments = segment(gps, away, adv);

  const dropped: DroppedSegment[] = [];
  const ranges: Range[] = [];
  for (const s of segments) {
    const first = s.away[0];
    const last = s.away[s.away.length - 1];
    const days = localDayNumber(last) - localDayNumber(first) + 1;
    const ongoing =
      s.closedBy === 'end' &&
      now - last.takenAt <= adv.ongoingGraceDays * 86_400_000;
    const reason: DroppedSegment['reason'] | null =
      params.minimumYear !== undefined &&
      Number(first.localDateTime.slice(0, 4)) < params.minimumYear
        ? 'before-minimum-year'
        : days > adv.maxTripDays
          ? 'too-long'
          : days < params.minTripDays
            ? 'too-short'
            : s.away.length < adv.minAwayAssets
              ? 'too-few-assets'
              : null;
    if (reason) {
      dropped.push({
        localStart: first.localDateTime,
        localEnd: last.localDateTime,
        countries: rankByDays(s.away, (a) => a.country),
        awayAssets: s.away.length,
        reason,
      });
      continue;
    }
    const i = indexOf.get(first.id)!;
    const k = indexOf.get(last.id)!;
    const start = departure(gps, i, home, adv);
    const end: Boundary = ongoing
      ? {
          instant: Math.max(now, last.takenAt),
          local: localAt(last, Math.max(now, last.takenAt)),
          rule: 'core',
        }
      : arrival(gps, k, home, adv);
    ranges.push({ segment: s, first: i, last: k, start, end, ongoing });
  }

  // Neighbouring trips never overlap: travel days give way to the other trip's core.
  for (let r = 1; r < ranges.length; r++) {
    const prev = ranges[r - 1];
    const cur = ranges[r];
    const prevCoreEnd = gps[prev.last].takenAt;
    const curCoreStart = gps[cur.first].takenAt;
    if (prev.end.instant >= cur.start.instant) {
      if (prev.end.instant >= curCoreStart)
        prev.end = clamp(gps[prev.last], curCoreStart - 1);
      if (cur.start.instant <= prev.end.instant)
        cur.start = clamp(
          gps[cur.first],
          Math.max(prev.end.instant + 1, prevCoreEnd + 1),
        );
    }
  }

  const members = assign(ranges, gps, assets, ownerId, params, away);

  const trips = ranges.map((r, idx): DetectedTrip => {
    const countries = rankByDays(r.segment.away, (a) => a.country);
    const cities = rankByDays(r.segment.away, (a) => a.city).slice(0, 3);
    const localStart = r.start.local;
    const localEnd = r.end.local;
    const days = dayCount(localStart, localEnd);
    // Name and key follow the days away (core), not the travel days: an evening
    // flight should not put the previous month into the name, and the key stays
    // stable when a travel-day boundary moves between runs.
    const coreStartDay = gps[r.first].localDateTime.slice(0, 10);
    const coreEndDay = gps[r.last].localDateTime.slice(0, 10);
    return {
      key: `trip:${coreStartDay}`,
      start: r.start.instant,
      end: r.end.instant,
      localStart,
      localEnd,
      coreStart: gps[r.first].takenAt,
      coreEnd: gps[r.last].takenAt,
      ongoing: r.ongoing,
      startRule: r.start.rule,
      endRule: r.end.rule,
      countries,
      cities,
      days,
      name: renderName(
        params.nameTemplate,
        {
          countries,
          cities,
          start: coreStartDay,
          end: coreEndDay,
          days: dayCount(coreStartDay, coreEndDay),
        },
        params.locale,
      ),
      assets: members[idx],
    };
  });

  return { trips, dropped, home };
}

/** Calendar days from the local date of `from` to that of `to`, inclusive. */
function dayCount(from: string, to: string): number {
  return (
    Math.round(
      (Date.parse(`${to.slice(0, 10)}T00:00:00Z`) -
        Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) /
        86_400_000,
    ) + 1
  );
}

function clamp(anchor: IndexedAsset, instant: number): Boundary {
  return { instant, local: localAt(anchor, instant), rule: 'core' };
}

/**
 * Puts assets into trips (SDD §5.5): GPS assets and assets with a time zone
 * by instant; assets without a time zone (their instant is the wall clock
 * read as UTC, API notes §10.3) by local time. Each asset joins at most one
 * trip.
 */
function assign(
  ranges: Range[],
  gps: readonly IndexedAsset[],
  assets: readonly IndexedAsset[],
  ownerId: string,
  params: TripParams,
  away: (a: IndexedAsset) => boolean,
): TripAsset[][] {
  const out: TripAsset[][] = ranges.map(() => []);
  if (ranges.length === 0) return out;

  for (const a of assets) {
    const gpsAsset = hasGps(a);
    if (!gpsAsset) {
      if (params.fillWithoutGps === 'none') continue;
      if (
        params.fillWithoutGps === 'camera' &&
        (!a.hasCamera || a.isScreenshot)
      )
        continue;
    }
    const byLocal = !gpsAsset && a.timeZone === null;
    const idx = byLocal
      ? findRange(ranges, (r) => [r.start.local, r.end.local], a.localDateTime)
      : findRange(ranges, (r) => [r.start.instant, r.end.instant], a.takenAt);
    if (idx < 0) continue;
    const r = ranges[idx];

    const reasons: TripReason[] = [];
    if (gpsAsset) reasons.push(away(a) ? 'gps-away' : 'gps-in-range');
    else reasons.push(a.hasCamera ? 'no-gps-camera' : 'no-gps');
    const before = byLocal
      ? a.localDateTime < gps[r.first].localDateTime
      : a.takenAt < gps[r.first].takenAt;
    const after = byLocal
      ? a.localDateTime > gps[r.last].localDateTime
      : a.takenAt > gps[r.last].takenAt;
    if (before) reasons.push('transit-departure');
    else if (after && !r.ongoing) reasons.push('transit-return');
    if (a.ownerId !== ownerId) reasons.push('partner');
    out[idx].push({ assetId: a.id, reasons });
  }
  return out;
}

/** Index of the range containing `value` (inclusive ends); ranges are ordered and disjoint. */
function findRange<T extends number | string>(
  ranges: Range[],
  bounds: (r: Range) => [T, T],
  value: T,
): number {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [s, e] = bounds(ranges[mid]);
    if (value < s) hi = mid - 1;
    else if (value > e) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Distinct values ordered by distinct local days (most first), then name. */
function rankByDays(
  assets: readonly IndexedAsset[],
  value: (a: IndexedAsset) => string | null,
): string[] {
  const days = new Map<string, Set<number>>();
  for (const a of assets) {
    const v = value(a);
    if (!v) continue;
    const set = days.get(v) ?? new Set<number>();
    set.add(localDayNumber(a));
    days.set(v, set);
  }
  return [...days.entries()]
    .sort(([a, x], [b, y]) => y.size - x.size || (a < b ? -1 : 1))
    .map(([v]) => v);
}

/** Home per month (first day of each month), compressed into periods. For the tuning CLI. */
export function homePeriods(
  home: HomeModel,
  assets: readonly IndexedAsset[],
): {
  from: string;
  to: string;
  country: string | null;
  place: string | null;
}[] {
  if (assets.length === 0) return [];
  const days = assets.map(localDayNumber);
  const first = Math.min(...days);
  const last = Math.max(...days);
  const out: {
    from: string;
    to: string;
    country: string | null;
    place: string | null;
  }[] = [];
  const d = new Date(first * 86_400_000);
  d.setUTCDate(1);
  for (; d.getTime() <= last * 86_400_000; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const day = Math.floor(d.getTime() / 86_400_000);
    const h = home.at(day);
    const p = h.places[0];
    const place = p
      ? `${p.latitude.toFixed(2)},${p.longitude.toFixed(2)}`
      : null;
    const month = dayString(day).slice(0, 7);
    const prev = out[out.length - 1];
    if (prev && prev.country === h.country && prev.place === place)
      prev.to = month;
    else out.push({ from: month, to: month, country: h.country, place });
  }
  return out;
}
