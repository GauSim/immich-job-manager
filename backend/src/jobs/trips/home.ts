import type { IndexedAsset } from '../../asset-index/asset-index.mapping.js';
import { cellKey, distanceKm, hasGps, localDayNumber } from './geo-time.js';

export interface HomePlace {
  latitude: number;
  longitude: number;
  /** Distinct days in the window with a photo in this ~1 km cell. */
  days: number;
}

export interface Home {
  /** Most frequent country (by distinct days); null without data. */
  country: string | null;
  /** Home places (~1 km cells) in the home country, most frequent first (max 3). */
  places: HomePlace[];
}

/** Fewer GPS days than this in the window → widen it (sparse years). */
const MIN_WINDOW_DAYS = 5;
/** Never look further than this for a home (days). */
const MAX_WINDOW_DAYS = 730;
/** A place counts as home when used on ≥ this share of the top place's days. */
const SECONDARY_PLACE_SHARE = 0.25;
const MAX_PLACES = 3;

interface Day {
  day: number;
  countries: Set<string>;
  /** cell → coordinate sums for the cell centre, and the cell's country. */
  cells: Map<
    string,
    { lat: number; lon: number; n: number; country: string | null }
  >;
}

/**
 * Infers home per local calendar day (trip-albums SDD §5.1): the country and
 * places with the most distinct photo days within ± `windowDays`. Weighting by
 * days, not photos, keeps a photo-heavy holiday from becoming "home"; the
 * symmetric window makes a move abroad switch home right at the move.
 */
export class HomeModel {
  private readonly days: Day[];
  private readonly cache = new Map<number, Home>();

  /** `gpsAssets`: the user's own assets; others without GPS are ignored. */
  constructor(
    gpsAssets: readonly IndexedAsset[],
    private readonly windowDays: number,
  ) {
    const byDay = new Map<number, Day>();
    for (const a of gpsAssets) {
      if (!hasGps(a)) continue;
      const day = localDayNumber(a);
      let d = byDay.get(day);
      if (!d) {
        d = { day, countries: new Set(), cells: new Map() };
        byDay.set(day, d);
      }
      if (a.country) d.countries.add(a.country);
      const key = cellKey(a.latitude, a.longitude);
      const c = d.cells.get(key) ?? {
        lat: 0,
        lon: 0,
        n: 0,
        country: a.country,
      };
      c.lat += a.latitude;
      c.lon += a.longitude;
      c.n++;
      c.country ??= a.country;
      d.cells.set(key, c);
    }
    this.days = [...byDay.values()].sort((a, b) => a.day - b.day);
  }

  /** Home on local day number `day`. */
  at(day: number): Home {
    let home = this.cache.get(day);
    if (!home) {
      home = this.compute(day);
      this.cache.set(day, home);
    }
    return home;
  }

  /** Home on the local day of `asset`. */
  of(asset: IndexedAsset): Home {
    return this.at(localDayNumber(asset));
  }

  /** Distance (km) from `asset` to the nearest home place of its day; null if unknown. */
  distanceFromHome(asset: IndexedAsset): number | null {
    if (!hasGps(asset)) return null;
    const { places } = this.of(asset);
    if (places.length === 0) return null;
    return Math.min(
      ...places.map((p) =>
        distanceKm(asset.latitude, asset.longitude, p.latitude, p.longitude),
      ),
    );
  }

  /** GPS asset within `radiusKm` of a home place of its day. */
  isAtHomePlace(asset: IndexedAsset, radiusKm: number): boolean {
    const d = this.distanceFromHome(asset);
    return d !== null && d <= radiusKm;
  }

  private compute(day: number): Home {
    let window = this.windowDays;
    let days = this.inWindow(day, window);
    while (days.length < MIN_WINDOW_DAYS && window < MAX_WINDOW_DAYS) {
      window = Math.min(window * 2, MAX_WINDOW_DAYS);
      days = this.inWindow(day, window);
    }
    if (days.length === 0) return { country: null, places: [] };

    const countryDays = new Map<string, number>();
    for (const d of days)
      for (const c of d.countries)
        countryDays.set(c, (countryDays.get(c) ?? 0) + 1);
    const country = top(countryDays);

    const cellDays = new Map<
      string,
      { days: number; lat: number; lon: number; n: number }
    >();
    for (const d of days) {
      for (const [key, c] of d.cells) {
        if (country !== null && c.country !== null && c.country !== country)
          continue;
        const agg = cellDays.get(key) ?? { days: 0, lat: 0, lon: 0, n: 0 };
        agg.days++;
        agg.lat += c.lat;
        agg.lon += c.lon;
        agg.n += c.n;
        cellDays.set(key, agg);
      }
    }
    const ranked = [...cellDays.entries()].sort(
      ([ka, a], [kb, b]) => b.days - a.days || (ka < kb ? -1 : 1),
    );
    const best = ranked[0]?.[1].days ?? 0;
    const places = ranked
      .filter(([, c]) => c.days >= Math.max(2, best * SECONDARY_PLACE_SHARE))
      .slice(0, MAX_PLACES)
      .map(([, c]) => ({
        latitude: c.lat / c.n,
        longitude: c.lon / c.n,
        days: c.days,
      }));
    // A single photo day is still better than nothing for sparse data.
    if (places.length === 0 && ranked.length > 0) {
      const [, c] = ranked[0];
      places.push({
        latitude: c.lat / c.n,
        longitude: c.lon / c.n,
        days: c.days,
      });
    }
    return { country, places };
  }

  private inWindow(day: number, window: number): Day[] {
    const from = lowerBound(this.days, day - window);
    const to = lowerBound(this.days, day + window + 1);
    return this.days.slice(from, to);
  }
}

function lowerBound(days: Day[], day: number): number {
  let lo = 0;
  let hi = days.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (days[mid].day < day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Key with the highest count; ties → alphabetical (deterministic). */
function top(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN || (n === bestN && best !== null && k < best)) {
      best = k;
      bestN = n;
    }
  }
  return best;
}
