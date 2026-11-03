import type { IndexedAsset } from '../../src/asset-index/asset-index.mapping.js';

export interface Place {
  latitude: number;
  longitude: number;
  country: string | null;
  city: string | null;
  /** UTC offset in hours. */
  utcOffset: number;
}

export const PLACES = {
  berlinHome: {
    latitude: 52.52,
    longitude: 13.405,
    country: 'Germany',
    city: 'Berlin',
    utcOffset: 1,
  },
  berlinOffice: {
    latitude: 52.5,
    longitude: 13.45,
    country: 'Germany',
    city: 'Berlin',
    utcOffset: 1,
  },
  ber: {
    latitude: 52.366,
    longitude: 13.503,
    country: 'Germany',
    city: 'Schönefeld',
    utcOffset: 1,
  },
  munich: {
    latitude: 48.137,
    longitude: 11.575,
    country: 'Germany',
    city: 'Munich',
    utcOffset: 1,
  },
  bangkok: {
    latitude: 13.75,
    longitude: 100.5,
    country: 'Thailand',
    city: 'Bangkok',
    utcOffset: 7,
  },
  bkk: {
    latitude: 13.69,
    longitude: 100.75,
    country: 'Thailand',
    city: 'Bang Phli',
    utcOffset: 7,
  },
  chiangMai: {
    latitude: 18.79,
    longitude: 98.98,
    country: 'Thailand',
    city: 'Chiang Mai',
    utcOffset: 7,
  },
  siemReap: {
    latitude: 13.36,
    longitude: 103.86,
    country: 'Cambodia',
    city: 'Siem Reap',
    utcOffset: 7,
  },
  amsterdam: {
    latitude: 52.37,
    longitude: 4.9,
    country: 'Netherlands',
    city: 'Amsterdam',
    utcOffset: 1,
  },
  prague: {
    latitude: 50.08,
    longitude: 14.43,
    country: 'Czechia',
    city: 'Prague',
    utcOffset: 1,
  },
  atSea: {
    latitude: 54.8,
    longitude: 7.5,
    country: null,
    city: null,
    utcOffset: 1,
  },
} satisfies Record<string, Place>;

export interface ShotOptions {
  /** Camera EXIF present (default true). */
  camera?: boolean;
  /** No time zone: the instant is the wall clock read as UTC (cameras without GPS). */
  noTimeZone?: boolean;
  screenshot?: boolean;
  ownerId?: string;
  type?: 'IMAGE' | 'VIDEO';
  visibility?: 'timeline' | 'archive';
  /** UTC offset when there is no place (default 1). */
  utcOffset?: number;
  id?: string;
}

/** Builds synthetic index rows, one per photo, by local wall-clock time and place. */
export class Timeline {
  readonly assets: IndexedAsset[] = [];
  private seq = 0;

  constructor(readonly ownerId = 'me') {}

  /** One asset at local time `local` (`2026-03-03T13:40`), with GPS at `place` or none. */
  shot(
    local: string,
    place: Place | null,
    options: ShotOptions = {},
  ): IndexedAsset {
    const wall = Date.parse(`${local.length === 16 ? `${local}:00` : local}Z`);
    const offset = place?.utcOffset ?? options.utcOffset ?? 1;
    const noTz = options.noTimeZone ?? false;
    const asset: IndexedAsset = {
      id: options.id ?? `a${String(++this.seq).padStart(5, '0')}`,
      ownerId: options.ownerId ?? this.ownerId,
      type: options.type ?? 'IMAGE',
      visibility: options.visibility ?? 'timeline',
      takenAt: noTz ? wall : wall - offset * 3_600_000,
      localDateTime: new Date(wall).toISOString().slice(0, -1),
      timeZone: noTz ? null : `UTC+${offset}`,
      latitude: place?.latitude ?? null,
      longitude: place?.longitude ?? null,
      city: place?.city ?? null,
      state: null,
      country: place?.country ?? null,
      hasCamera: options.camera ?? true,
      isScreenshot: options.screenshot ?? false,
      fileName: `IMG_${this.seq}.jpg`,
    };
    this.assets.push(asset);
    return asset;
  }

  /** Two GPS photos per day (09:00, 19:00) at `place` for local days `from`..`to` inclusive. */
  days(
    from: string,
    to: string,
    place: Place,
    options: ShotOptions = {},
  ): this {
    for (
      let d = Date.parse(`${from}T00:00:00Z`);
      d <= Date.parse(`${to}T00:00:00Z`);
      d += 86_400_000
    ) {
      const day = new Date(d).toISOString().slice(0, 10);
      this.shot(`${day}T09:00`, place, options);
      this.shot(`${day}T19:00`, place, options);
    }
    return this;
  }
}
