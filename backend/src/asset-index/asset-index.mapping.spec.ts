import { immichAsset } from '../../test/support/immich-asset.js';
import type { AssetResponseDto } from '../immich/immich.client.js';
import { toIndexRow } from './asset-index.mapping.js';

describe('toIndexRow', () => {
  it('maps a phone photo with GPS', () => {
    expect(toIndexRow(immichAsset('a'))).toEqual({
      id: 'a',
      ownerId: 'me',
      type: 'IMAGE',
      visibility: 'timeline',
      takenAt: Date.parse('2026-03-04T00:20:00.000Z'),
      localDateTime: '2026-03-04T07:20:00.000',
      timeZone: 'Asia/Bangkok',
      latitude: 13.75,
      longitude: 100.5,
      city: 'Bangkok',
      state: 'Bangkok',
      country: 'Thailand',
      hasCamera: true,
      isScreenshot: false,
      fileName: 'a.heic',
      immichUpdatedAt: Date.parse('2026-03-05T10:00:00.000Z'),
    });
  });

  it('treats null and empty strings as missing', () => {
    const row = toIndexRow(
      immichAsset(
        'b',
        {},
        {
          make: '',
          model: null,
          latitude: null,
          longitude: null,
          city: null,
          state: '',
          country: null,
          timeZone: null,
        },
      ),
    )!;
    expect(row).toMatchObject({
      hasCamera: false,
      latitude: null,
      longitude: null,
      city: null,
      state: null,
      country: null,
      timeZone: null,
    });
  });

  it('counts a camera with only a model as a camera', () => {
    expect(
      toIndexRow(immichAsset('c', {}, { make: null, model: 'Z 6' }))!.hasCamera,
    ).toBe(true);
  });

  it('drops half a coordinate pair', () => {
    expect(
      toIndexRow(immichAsset('d', {}, { latitude: 52.5, longitude: null })),
    ).toMatchObject({ latitude: null, longitude: null });
  });

  it('flags iOS screenshots', () => {
    expect(
      toIndexRow(immichAsset('e', {}, { description: 'Screenshot' }))!
        .isScreenshot,
    ).toBe(true);
  });

  it('keeps videos and archived assets', () => {
    expect(
      toIndexRow(
        immichAsset('v', {
          type: 'VIDEO',
          visibility: 'archive',
        } as Partial<AssetResponseDto>),
      ),
    ).toMatchObject({ type: 'VIDEO', visibility: 'archive' });
  });

  it.each([
    ['audio', { type: 'AUDIO' }],
    ['hidden (Live Photo motion part)', { visibility: 'hidden' }],
    ['locked', { visibility: 'locked' }],
    ['trashed', { isTrashed: true }],
    ['without a date', { fileCreatedAt: 'nope' }],
  ])('skips %s assets', (_, extra) => {
    expect(
      toIndexRow(immichAsset('x', extra as Partial<AssetResponseDto>)),
    ).toBeNull();
  });

  it('works without exifInfo', () => {
    expect(
      toIndexRow(
        immichAsset('n', { exifInfo: undefined } as Partial<AssetResponseDto>),
      ),
    ).toMatchObject({ hasCamera: false, latitude: null, isScreenshot: false });
  });
});
