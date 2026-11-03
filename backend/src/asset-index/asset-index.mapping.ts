import type { AssetResponseDto } from '../immich/immich.client.js';

/** Asset types and visibilities the index holds (the widest scope any group job reads). */
export const INDEX_TYPES = ['IMAGE', 'VIDEO'] as const;
export const INDEX_VISIBILITIES = ['timeline', 'archive'] as const;
export type IndexType = (typeof INDEX_TYPES)[number];
export type IndexVisibility = (typeof INDEX_VISIBILITIES)[number];

/** One asset in the index, as group jobs read it (compact, in memory). */
export interface IndexedAsset {
  id: string;
  ownerId: string;
  type: IndexType;
  visibility: IndexVisibility;
  /** `fileCreatedAt` in ms. Only a real instant when `timeZone` is set (API notes §10.3). */
  takenAt: number;
  /** Wall-clock capture time, ISO without zone, e.g. `2026-03-04T07:20:00.000`. */
  localDateTime: string;
  timeZone: string | null;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  hasCamera: boolean;
  isScreenshot: boolean;
  fileName: string;
}

export interface IndexRow extends IndexedAsset {
  /** Immich `updatedAt` in ms. */
  immichUpdatedAt: number;
}

/** `null` and `""` both count as empty (API notes §4.2). */
function blank(v: string | null | undefined): boolean {
  return v == null || v.trim() === '';
}

function text(v: string | null | undefined): string | null {
  return blank(v) ? null : v!;
}

function coordinate(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Maps a `/search/metadata` item (with EXIF) to an index row; `null` for
 * assets outside the index scope (other types, hidden/locked, trashed) or
 * without a usable capture time.
 */
export function toIndexRow(asset: AssetResponseDto): IndexRow | null {
  if (!(INDEX_TYPES as readonly string[]).includes(asset.type)) return null;
  if (!(INDEX_VISIBILITIES as readonly string[]).includes(asset.visibility))
    return null;
  if (asset.isTrashed) return null;
  const takenAt = Date.parse(asset.fileCreatedAt);
  const local = Date.parse(asset.localDateTime);
  if (!Number.isFinite(takenAt) || !Number.isFinite(local)) return null;

  const e = asset.exifInfo;
  const latitude = coordinate(e?.latitude);
  const longitude = coordinate(e?.longitude);
  const hasGps = latitude !== null && longitude !== null;
  return {
    id: asset.id,
    ownerId: asset.ownerId,
    type: asset.type as IndexType,
    visibility: asset.visibility as IndexVisibility,
    takenAt,
    // Immich serialises local time with a fake `Z`; drop it so it can't be mistaken for UTC.
    localDateTime: new Date(local).toISOString().slice(0, -1),
    timeZone: text(e?.timeZone),
    latitude: hasGps ? latitude : null,
    longitude: hasGps ? longitude : null,
    city: text(e?.city),
    state: text(e?.state),
    country: text(e?.country),
    hasCamera: !blank(e?.make) || !blank(e?.model),
    isScreenshot: e?.description === 'Screenshot',
    fileName: asset.originalFileName,
    immichUpdatedAt: Date.parse(asset.updatedAt) || 0,
  };
}
