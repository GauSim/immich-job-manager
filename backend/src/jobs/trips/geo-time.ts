import type { IndexedAsset } from '../../asset-index/asset-index.mapping.js';

const EARTH_RADIUS_KM = 6371;
const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export const hours = (h: number) => h * HOUR_MS;

export function hasGps(
  a: IndexedAsset,
): a is IndexedAsset & { latitude: number; longitude: number } {
  return a.latitude !== null && a.longitude !== null;
}

/** Great-circle distance (haversine) in km. */
export function distanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Implied travel speed between two GPS assets (by instant), km/h. */
export function speedKmh(
  a: IndexedAsset & { latitude: number; longitude: number },
  b: IndexedAsset & { latitude: number; longitude: number },
): number {
  const km = distanceKm(a.latitude, a.longitude, b.latitude, b.longitude);
  const h = Math.abs(b.takenAt - a.takenAt) / HOUR_MS;
  return h === 0 ? (km > 0 ? Infinity : 0) : km / h;
}

/** ~1 km grid cell (0.01°) used for the home location. */
export function cellKey(lat: number, lon: number): string {
  return `${Math.round(lat * 100)}:${Math.round(lon * 100)}`;
}

/** Wall-clock time as if it were UTC, in ms (`localDateTime` has no zone). */
export function localMs(a: Pick<IndexedAsset, 'localDateTime'>): number {
  return Date.parse(`${a.localDateTime}Z`);
}

/** Local calendar day number (days since 1970-01-01, wall clock). */
export function localDayNumber(a: Pick<IndexedAsset, 'localDateTime'>): number {
  return Math.floor(localMs(a) / DAY_MS);
}

export function dayString(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** `local` ISO (no zone) of instant `t`, using the UTC offset of `anchor`. */
export function localAt(anchor: IndexedAsset, t: number): string {
  const offset = localMs(anchor) - anchor.takenAt;
  return new Date(t + offset).toISOString().slice(0, -1);
}

/** Instant of a wall-clock time (`localIsoNoZone`), using the UTC offset of `anchor`. */
export function instantAt(
  anchor: IndexedAsset,
  localIsoNoZone: string,
): number {
  const offset = localMs(anchor) - anchor.takenAt;
  return Date.parse(`${localIsoNoZone}Z`) - offset;
}
