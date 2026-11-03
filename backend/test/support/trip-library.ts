import type { IndexedAsset } from '../../src/asset-index/asset-index.mapping.js';
import { FakeImmichLibrary } from './fake-immich-server.js';

/** Index row (from the timeline builder) → `/search/metadata` item. */
export function toImmich(
  a: IndexedAsset,
): Record<string, unknown> & { id: string } {
  return {
    id: a.id,
    ownerId: a.ownerId,
    type: a.type,
    visibility: a.visibility,
    isTrashed: false,
    originalFileName: a.fileName,
    fileCreatedAt: new Date(a.takenAt).toISOString(),
    localDateTime: `${a.localDateTime}Z`,
    updatedAt: FakeImmichLibrary.OLD_DATE,
    exifInfo: {
      latitude: a.latitude,
      longitude: a.longitude,
      city: a.city,
      state: a.state,
      country: a.country,
      timeZone: a.timeZone,
      make: a.hasCamera ? 'Apple' : null,
      model: a.hasCamera ? 'iPhone 16' : null,
      description: a.isScreenshot ? 'Screenshot' : '',
    },
  };
}
