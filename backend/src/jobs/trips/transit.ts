import type { IndexedAsset } from '../../asset-index/asset-index.mapping.js';
import {
  hasGps,
  hours,
  instantAt,
  localAt,
  localDayNumber,
  dayString,
  speedKmh,
} from './geo-time.js';
import type { HomeModel } from './home.js';

/** One end of a trip range. */
export interface Boundary {
  /** Instant (ms), inclusive. */
  instant: number;
  /** Same moment as local wall-clock time (ISO, no zone), for assets without a reliable instant. */
  local: string;
  /** How it was found (shown in the tuning CLI). */
  rule: 'after-home' | 'transit-point' | 'local-day' | 'core';
}

export interface TransitOptions {
  maxTransitHours: number;
  transitSpeedKmh: number;
  homeRadiusKm: number;
}

/**
 * Departure (trip-albums SDD §5.4): the trip starts right after the user was
 * last seen at a home place. Walks back from the first away point `gps[i]`
 * over GPS points (not at home) while within the limit. A long-distance jump
 * (flight, train) into the trip allows the full `maxTransitHours`; otherwise
 * only the same local day.
 */
export function departure(
  gps: readonly IndexedAsset[],
  i: number,
  home: HomeModel,
  options: TransitOptions,
): Boundary {
  const a = gps[i];
  const prev = i > 0 ? gps[i - 1] : undefined;
  const jump =
    prev !== undefined &&
    hasGps(prev) &&
    hasGps(a) &&
    speedKmh(prev, a) > options.transitSpeedKmh;
  const dayStart = instantAt(a, `${dayString(localDayNumber(a))}T00:00:00.000`);
  const limit = Math.max(
    a.takenAt - hours(options.maxTransitHours),
    jump ? -Infinity : dayStart,
  );

  let earliest: IndexedAsset | undefined;
  for (let j = i - 1; j >= 0 && gps[j].takenAt >= limit; j--) {
    const p = gps[j];
    if (home.isAtHomePlace(p, options.homeRadiusKm))
      return {
        instant: p.takenAt + 1,
        local: localAt(p, p.takenAt + 1),
        rule: 'after-home',
      };
    earliest = p;
  }
  if (earliest)
    return {
      instant: earliest.takenAt,
      local: earliest.localDateTime,
      rule: 'transit-point',
    };
  const start = Math.max(dayStart, a.takenAt - hours(options.maxTransitHours));
  return { instant: start, local: localAt(a, start), rule: 'local-day' };
}

/** Return: mirror of {@link departure} from the last away point `gps[k]`. */
export function arrival(
  gps: readonly IndexedAsset[],
  k: number,
  home: HomeModel,
  options: TransitOptions,
): Boundary {
  const z = gps[k];
  const next = k + 1 < gps.length ? gps[k + 1] : undefined;
  const jump =
    next !== undefined &&
    hasGps(next) &&
    hasGps(z) &&
    speedKmh(z, next) > options.transitSpeedKmh;
  const dayEnd =
    instantAt(z, `${dayString(localDayNumber(z) + 1)}T00:00:00.000`) - 1;
  const limit = Math.min(
    z.takenAt + hours(options.maxTransitHours),
    jump ? Infinity : dayEnd,
  );

  let latest: IndexedAsset | undefined;
  for (let j = k + 1; j < gps.length && gps[j].takenAt <= limit; j++) {
    const p = gps[j];
    if (home.isAtHomePlace(p, options.homeRadiusKm))
      return {
        instant: p.takenAt - 1,
        local: localAt(p, p.takenAt - 1),
        rule: 'after-home',
      };
    latest = p;
  }
  if (latest)
    return {
      instant: latest.takenAt,
      local: latest.localDateTime,
      rule: 'transit-point',
    };
  const end = Math.min(dayEnd, z.takenAt + hours(options.maxTransitHours));
  return { instant: end, local: localAt(z, end), rule: 'local-day' };
}
