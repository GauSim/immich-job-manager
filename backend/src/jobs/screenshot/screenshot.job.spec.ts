import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CandidateBatch, JobContext } from '../../core/job-type.js';
import type {
  AssetResponseDto,
  ImmichClient,
} from '../../immich/immich.client.js';
import {
  DEFAULT_SCREENSHOT_PARAMS,
  ScreenshotParams,
} from './screenshot.params.js';
import { ScreenshotJob } from './screenshot.job.js';
import {
  buildScreenshotScorers,
  scoreScreenshot,
} from './screenshot.scoring.js';

type Label = 'screenshot' | 'photo' | 'unknown';
type Fixture = AssetResponseDto & { label: Label };

/** Anonymised metadata of ~1,000 images of a real library (tools/immich-spike/anonymise-metadata.py). */
const realLibrary = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '../../../test/fixtures/real-library-sample.json',
    ),
    'utf8',
  ),
) as Fixture[];

type Exif = NonNullable<AssetResponseDto['exifInfo']>;
const exif = (over: Partial<Exif> = {}): Exif =>
  ({
    make: null,
    model: null,
    lensModel: null,
    exposureTime: null,
    fNumber: null,
    description: '',
    ...over,
  }) as Exif;

const asset = (
  name: string,
  mime: string,
  w: number,
  h: number,
  ex: Exif = exif(),
): AssetResponseDto =>
  ({
    id: name,
    originalFileName: name,
    originalMimeType: mime,
    width: w,
    height: h,
    exifInfo: ex,
    type: 'IMAGE',
  }) as AssetResponseDto;

const camera = exif({
  make: 'Apple',
  model: 'iPhone 17 Pro',
  lensModel: 'back camera',
  exposureTime: '1/120',
  fNumber: 1.8,
});
const tagged = exif({ description: 'Screenshot' });

const score = (a: AssetResponseDto, params: Partial<ScreenshotParams> = {}) =>
  scoreScreenshot(a, buildScreenshotScorers(ScreenshotParams.parse(params)));

describe('screenshot scoring', () => {
  const ALL = ['png', 'no-camera-exif', 'screen-size'];
  it.each<[string, AssetResponseDto, number, string[]]>([
    [
      'iOS screenshot (description tag)',
      asset('IMG_0001.PNG', 'image/png', 1320, 2868, tagged),
      1,
      ['description-tag', ...ALL],
    ],
    [
      'cropped iOS screenshot saved as JPEG',
      asset('IMG_0002.JPG', 'image/jpeg', 1320, 1535, tagged),
      1,
      ['description-tag', 'no-camera-exif'],
    ],
    [
      'iOS screenshot, tag lost (re-encoded)',
      asset('IMG_0003.PNG', 'image/png', 1179, 2556),
      0.6,
      ALL,
    ],
    [
      'Android screenshot',
      asset('Screenshot_20260101-120000.png', 'image/png', 1080, 2400),
      1,
      ['filename', ...ALL],
    ],
    [
      'macOS screenshot (German)',
      asset(
        'Bildschirmfoto 2026-01-01 um 12.00.00.png',
        'image/png',
        2880,
        1800,
      ),
      1,
      ['filename', ...ALL],
    ],
    [
      "macOS screenshot (French, straight ')",
      asset("Capture d'écran 2026.png", 'image/png', 1512, 982),
      1,
      ['filename', 'png', 'no-camera-exif'],
    ],
    [
      'screenshot sent via messenger (JPEG, no EXIF)',
      asset('IMG-20260101-WA0001.jpg', 'image/jpeg', 1179, 2556),
      0.35,
      ['no-camera-exif', 'screen-size'],
    ],
    [
      'camera photo HEIC',
      asset('IMG_1234.HEIC', 'image/heic', 4032, 3024, camera),
      0,
      [],
    ],
    [
      'camera photo named like a screenshot',
      asset('Screenshot of sunset.jpg', 'image/jpeg', 4032, 3024, camera),
      0.6,
      ['filename'],
    ],
    [
      'exported graphic (square PNG)',
      asset('logo.png', 'image/png', 1080, 1080),
      0.4,
      ['png', 'no-camera-exif'],
    ],
    [
      'generated image 1024x1536 PNG',
      asset('IMG_1641.PNG', 'image/png', 1024, 1536),
      0.4,
      ['png', 'no-camera-exif'],
    ],
    [
      'wallpaper PNG at screen size (known false positive)',
      asset('wallpaper.png', 'image/png', 1290, 2796),
      0.6,
      ALL,
    ],
    [
      'tall panorama strip without EXIF',
      asset('pano.jpg', 'image/jpeg', 8000, 2000),
      0.35,
      ['no-camera-exif', 'screen-size'],
    ],
  ])('%s', (_name, a, expectedScore, expectedReasons) => {
    expect(score(a)).toEqual({
      score: expectedScore,
      reasons: expectedReasons,
    });
  });

  it('description tags are configurable and case-insensitive', () => {
    const a = asset(
      'x.png',
      'image/png',
      100,
      100,
      exif({ description: ' screenshot ' }),
    );
    expect(score(a).reasons).toContain('description-tag');
    expect(score(a, { descriptionTags: [] }).reasons).not.toContain(
      'description-tag',
    );
  });

  it('screen resolutions match in either orientation and can be replaced', () => {
    const a = asset('x.png', 'image/png', 2868, 1320);
    expect(score(a).reasons).toContain('screen-size');
    expect(
      score(a, { screenResolutions: ['640x1136'], minAspectRatio: 3 }).reasons,
    ).not.toContain('screen-size');
  });
});

describe('screenshot scoring on a real library sample (anonymised, 999 images)', () => {
  const scorers = buildScreenshotScorers(DEFAULT_SCREENSHOT_PARAMS);
  const results = realLibrary.map((a) => ({
    a,
    ...scoreScreenshot(a, scorers),
  }));
  const matched = (label: Label) =>
    results.filter((r) => r.a.label === label && r.score >= 0.6);

  it('contains the expected mix', () => {
    const count = (label: Label) =>
      realLibrary.filter((a) => a.label === label).length;
    expect({
      screenshot: count('screenshot'),
      photo: count('photo'),
      unknown: count('unknown'),
    }).toEqual({
      screenshot: 96,
      photo: 679,
      unknown: 224,
    });
  });

  it('finds every tagged screenshot with score 1.0', () => {
    const shots = results.filter((r) => r.a.label === 'screenshot');
    expect(
      shots.every(
        (r) => r.score === 1 && r.reasons.includes('description-tag'),
      ),
    ).toBe(true);
  });

  it('never matches a camera photo', () => {
    expect(matched('photo')).toEqual([]);
  });

  it('matches at most a handful of untagged images at the default threshold', () => {
    // Untagged PNGs are mostly generated or saved images (1024x1536, 1672x941, …) scoring 0.4.
    expect(matched('unknown').length).toBeLessThanOrEqual(2);
  });
});

describe('ScreenshotJob.select', () => {
  const job = new ScreenshotJob();
  const page1 = [
    asset('IMG_0001.PNG', 'image/png', 1320, 2868, tagged),
    asset('IMG_1234.HEIC', 'image/heic', 4032, 3024, camera),
  ];
  const page2 = [asset('Screenshot_1.png', 'image/png', 1080, 2400)];

  function setup(params: Partial<ScreenshotParams> = {}, resumeFrom?: string) {
    const queries: Record<string, unknown>[] = [];
    const logs: string[] = [];
    const immich = {
      searchMetadataPage: async (q: Record<string, unknown>) => {
        queries.push(q);
        return q.cursor
          ? { items: page2, nextCursor: null }
          : { items: page1, nextCursor: 'c2' };
      },
    } as unknown as ImmichClient;
    const ctx: JobContext<ScreenshotParams> = {
      runId: 'r',
      jobId: 'j',
      params: ScreenshotParams.parse(params),
      immich,
      resumeFrom,
      dryRun: true,
      signal: new AbortController().signal,
      log: {
        debug: () => {},
        info: (m) => logs.push(m),
        warn: (m) => logs.push(`WARN ${m}`),
        error: () => {},
      },
    };
    return { ctx, queries, logs };
  }

  const collect = async (it: AsyncIterable<CandidateBatch>) => {
    const out: CandidateBatch[] = [];
    for await (const b of it) out.push(b);
    return out;
  };

  it('scans images page by page and yields candidates with file names', async () => {
    const { ctx, queries, logs } = setup();
    expect(await collect(job.select(ctx))).toEqual([
      {
        scanned: 2,
        cursor: 'c2',
        candidates: [
          {
            assetId: 'IMG_0001.PNG',
            fileName: 'IMG_0001.PNG',
            score: 1,
            reasons: [
              'description-tag',
              'png',
              'no-camera-exif',
              'screen-size',
            ],
          },
        ],
      },
      {
        scanned: 1,
        cursor: null,
        candidates: [
          {
            assetId: 'Screenshot_1.png',
            fileName: 'Screenshot_1.png',
            score: 1,
            reasons: ['filename', 'png', 'no-camera-exif', 'screen-size'],
          },
        ],
      },
    ]);
    expect(queries[0]).toMatchObject({
      type: 'IMAGE',
      visibility: ['timeline'],
      withExif: true,
    });
    expect(logs.at(-1)).toBe(
      'Matches by signal: png 2, no-camera-exif 2, screen-size 2, description-tag 1, filename 1',
    );
  });

  it('includes archived assets on request and resumes from a cursor', async () => {
    const { ctx, queries } = setup({ includeArchived: true }, 'c2');
    expect(await collect(job.select(ctx))).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      cursor: 'c2',
      visibility: ['timeline', 'archive'],
    });
  });

  it('respects the threshold', async () => {
    const { ctx } = setup({ threshold: 1 });
    const ids = (await collect(job.select(ctx))).flatMap((b) =>
      b.candidates.map((c) => c.assetId),
    );
    expect(ids).toEqual(['IMG_0001.PNG', 'Screenshot_1.png']);
    const strict = setup({
      threshold: 1,
      descriptionTags: [],
      filenamePatterns: [],
    });
    expect(
      (await collect(job.select(strict.ctx))).flatMap((b) => b.candidates),
    ).toEqual([]);
  });

  it('warns that phase-6 signals are not active yet', async () => {
    const { ctx, logs } = setup({
      readIosTag: true,
      clip: { enabled: true, queries: ['x'], topN: 10 },
    });
    await collect(job.select(ctx));
    expect(logs.filter((l) => l.startsWith('WARN'))).toHaveLength(2);
  });

  it('has valid defaults', () => {
    expect(ScreenshotParams.parse({})).toEqual(job.defaultParams);
    expect(job.defaultParams).toMatchObject({
      threshold: 0.6,
      readIosTag: false,
      clip: { enabled: false },
    });
  });
});
