import type { AssetResponseDto } from '../../src/immich/immich.client.js';

/** A `/search/metadata` item with EXIF: an own iPhone photo in Bangkok (override as needed). */
export function immichAsset(
  id: string,
  extra: Partial<AssetResponseDto> = {},
  exif: Record<string, unknown> = {},
): AssetResponseDto {
  return {
    id,
    ownerId: 'me',
    type: 'IMAGE',
    visibility: 'timeline',
    isTrashed: false,
    originalFileName: `${id}.heic`,
    fileCreatedAt: '2026-03-04T00:20:00.000Z',
    localDateTime: '2026-03-04T07:20:00.000Z',
    updatedAt: '2026-03-05T10:00:00.000Z',
    exifInfo: {
      make: 'Apple',
      model: 'iPhone 16',
      latitude: 13.75,
      longitude: 100.5,
      city: 'Bangkok',
      state: 'Bangkok',
      country: 'Thailand',
      timeZone: 'Asia/Bangkok',
      description: '',
      ...exif,
    },
    ...extra,
  } as unknown as AssetResponseDto;
}
