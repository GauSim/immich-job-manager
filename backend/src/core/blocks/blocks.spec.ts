import type {
  AssetResponseDto,
  ImmichClient,
} from '../../immich/immich.client.js';
import {
  albumSource,
  allOf,
  aspectRatioAtLeast,
  dimensionsIn,
  exifScorer,
  filenameScorer,
  hasNoCameraExif,
  metadataSource,
  mimeTypeIs,
  scoreAsset,
} from './index.js';

const asset = (over: Partial<AssetResponseDto> = {}): AssetResponseDto =>
  ({
    id: 'a',
    originalFileName: 'IMG_0001.PNG',
    originalMimeType: 'image/png',
    width: 1179,
    height: 2556,
    ...over,
  }) as AssetResponseDto;

const camera = {
  make: 'Apple',
  model: 'iPhone 15',
  lensModel: null,
  exposureTime: '1/120',
  fNumber: 1.8,
};

describe('filenameScorer', () => {
  const scorer = filenameScorer(
    ['Screenshot', 'Capture d’écran', '/^Screen_\\d+/i'],
    { score: 0.6 },
  );

  it.each([
    ['Screenshot_20260101.png', true],
    ['SCREENSHOT 2026.PNG', true],
    ["Capture d'écran 2026-01-01.png", true], // straight apostrophe matches typographic pattern
    ['Capture d’écran 2026-01-01.png', true],
    ['screen_123.jpg', true], // regex
    ['IMG_0001.PNG', false],
  ])('%s → %s', (name, matches) => {
    expect(scorer(asset({ originalFileName: name }))).toEqual(
      matches ? { score: 0.6, reason: 'filename' } : null,
    );
  });

  it('ignores empty patterns', () => {
    expect(filenameScorer([''], { score: 1 })(asset())).toBeNull();
  });
});

describe('exif helpers', () => {
  it('detects missing camera EXIF, treating null and "" as empty', () => {
    expect(hasNoCameraExif(asset())).toBe(true);
    expect(
      hasNoCameraExif(asset({ exifInfo: { make: '', model: null } as never })),
    ).toBe(true);
    expect(hasNoCameraExif(asset({ exifInfo: camera as never }))).toBe(false);
  });

  it('matches MIME types case-insensitively', () => {
    expect(
      mimeTypeIs('image/png')(asset({ originalMimeType: 'IMAGE/PNG' })),
    ).toBe(true);
    expect(
      mimeTypeIs('image/png')(asset({ originalMimeType: 'image/jpeg' })),
    ).toBe(false);
  });

  it('matches resolutions in either orientation, falling back to EXIF dimensions', () => {
    const test = dimensionsIn([[1179, 2556]]);
    expect(test(asset())).toBe(true);
    expect(test(asset({ width: 2556, height: 1179 }))).toBe(true);
    expect(
      test(
        asset({
          width: null,
          height: null,
          exifInfo: { exifImageWidth: 1179, exifImageHeight: 2556 } as never,
        }),
      ),
    ).toBe(true);
    expect(test(asset({ width: 4032, height: 3024 }))).toBe(false);
  });

  it('checks aspect ratio', () => {
    expect(aspectRatioAtLeast(2)(asset())).toBe(true); // 2556/1179 ≈ 2.17
    expect(aspectRatioAtLeast(2)(asset({ width: 4032, height: 3024 }))).toBe(
      false,
    );
    expect(aspectRatioAtLeast(2)(asset({ width: null, height: null }))).toBe(
      false,
    );
  });
});

describe('scoreAsset', () => {
  const scorers = [
    filenameScorer(['Screenshot'], { score: 0.6 }),
    exifScorer([
      { reason: 'png', score: 0.25, test: mimeTypeIs('image/png') },
      { reason: 'no-camera-exif', score: 0.15, test: hasNoCameraExif },
      {
        reason: 'screen-size',
        score: 0.2,
        test: allOf(hasNoCameraExif, aspectRatioAtLeast(2)),
      },
    ]),
  ];

  it('sums contributions with reasons', () => {
    expect(scoreAsset(asset(), scorers)).toEqual({
      score: 0.6,
      reasons: ['png', 'no-camera-exif', 'screen-size'],
    });
  });

  it('caps at 1', () => {
    expect(
      scoreAsset(asset({ originalFileName: 'Screenshot.png' }), scorers).score,
    ).toBe(1);
  });

  it('scores 0 without matching signals', () => {
    expect(
      scoreAsset(
        asset({
          originalMimeType: 'image/jpeg',
          width: 4032,
          height: 3024,
          exifInfo: camera as never,
        }),
        scorers,
      ),
    ).toEqual({ score: 0, reasons: [] });
  });

  it('lets a decisive signal set 1.0', () => {
    expect(
      scoreAsset(asset(), [
        () => ({ score: 0, reason: 'ios-tag', decisive: true }),
      ]),
    ).toEqual({
      score: 1,
      reasons: ['ios-tag'],
    });
  });
});

describe('sources', () => {
  const pages: Record<
    string,
    { items: AssetResponseDto[]; nextCursor: string | null }
  > = {
    start: {
      items: [asset({ id: '1' }), asset({ id: '2' })],
      nextCursor: 'c2',
    },
    c2: { items: [asset({ id: '3' })], nextCursor: null },
  };
  const calls: unknown[] = [];
  const immich = {
    searchMetadataPage: async (q: { cursor?: string }) => {
      calls.push(q);
      return pages[q.cursor ?? 'start'];
    },
    listAlbumMemberIds: async () => ['x', 'y', 'x'],
  } as unknown as ImmichClient;

  beforeEach(() => (calls.length = 0));

  it('pages lazily through metadata search', async () => {
    const it = metadataSource(
      immich,
      { withExif: true },
      { since: new Date('2026-01-01T00:00:00Z') },
    );
    const first = await it.next();
    expect(calls).toHaveLength(1); // second page not fetched yet
    expect(first.value).toEqual({ assets: pages.start.items, cursor: 'c2' });
    const rest = [];
    for await (const p of it) rest.push(p);
    expect(rest).toEqual([{ assets: pages.c2.items, cursor: null }]);
    expect(calls[1]).toMatchObject({
      cursor: 'c2',
      withExif: true,
      updatedAfter: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('resumes from a cursor', async () => {
    const out = [];
    for await (const p of metadataSource(immich, {}, { resumeFrom: 'c2' }))
      out.push(p.assets.map((a) => a.id));
    expect(out).toEqual([['3']]);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      metadataSource(immich, {}, { signal: controller.signal }).next(),
    ).rejects.toThrow('stop');
  });

  it('albumSource returns a set of member ids', async () => {
    expect(await albumSource(immich, 'album')).toEqual(new Set(['x', 'y']));
  });
});
