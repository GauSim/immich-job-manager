import { EXPORT_OWNER, fromIndexExport } from './index-export.js';

const row = (extra: Record<string, unknown> = {}) => ({
  id: 'a',
  own: true,
  type: 'IMAGE',
  visibility: 'timeline',
  fileCreatedAt: '2026-03-04T00:20:00.000Z',
  localDateTime: '2026-03-04T07:20:00.000Z',
  timeZone: 'Asia/Bangkok',
  lat: 13.75,
  lon: 100.5,
  city: 'Bangkok',
  state: '',
  country: 'Thailand',
  make: 'Apple',
  model: 'iPhone 16',
  isScreenshot: false,
  deviceClass: 'phone',
  fileName: 'IMG_1.HEIC',
  ...extra,
});

describe('fromIndexExport', () => {
  it('maps spike export rows to index rows', () => {
    expect(fromIndexExport({ version: 1, assets: [row()] })).toEqual([
      {
        id: 'a',
        ownerId: EXPORT_OWNER,
        type: 'IMAGE',
        visibility: 'timeline',
        takenAt: Date.parse('2026-03-04T00:20:00.000Z'),
        localDateTime: '2026-03-04T07:20:00.000',
        timeZone: 'Asia/Bangkok',
        latitude: 13.75,
        longitude: 100.5,
        city: 'Bangkok',
        state: null,
        country: 'Thailand',
        hasCamera: true,
        isScreenshot: false,
        fileName: 'IMG_1.HEIC',
      },
    ]);
  });

  it('marks partner assets and missing camera / GPS', () => {
    const [a] = fromIndexExport({
      version: 1,
      assets: [row({ own: false, make: '', model: null, lat: null })],
    });
    expect(a).toMatchObject({
      ownerId: 'partner',
      hasCamera: false,
      latitude: null,
      longitude: null,
    });
  });

  it('skips rows outside the index scope', () => {
    expect(
      fromIndexExport({
        version: 1,
        assets: [
          row({ type: 'AUDIO' }),
          row({ visibility: 'hidden' }),
          row({ fileCreatedAt: 'x' }),
        ],
      }),
    ).toEqual([]);
  });

  it('rejects other files', () => {
    expect(() => fromIndexExport({ assets: [] })).toThrow(/trips index export/);
    expect(() => fromIndexExport(null)).toThrow();
  });
});
