import { z } from 'zod';

/** `WIDTHxHEIGHT`, e.g. `1179x2556`. Matched in either orientation. */
const resolution = z
  .string()
  .regex(/^\d{2,5}x\d{2,5}$/, 'must look like 1179x2556');

/** Default screen resolutions (portrait for phones/tablets, landscape for desktops). */
export const DEFAULT_SCREEN_RESOLUTIONS = [
  // iPhone
  '640x1136',
  '750x1334',
  '828x1792',
  '1080x1920',
  '1125x2436',
  '1170x2532',
  '1179x2556',
  '1206x2622',
  '1242x2208',
  '1242x2688',
  '1284x2778',
  '1290x2796',
  '1320x2868',
  // iPad
  '1488x2266',
  '1536x2048',
  '1620x2160',
  '1640x2360',
  '1668x2224',
  '1668x2388',
  '2048x2732',
  // Android
  '1080x2280',
  '1080x2340',
  '1080x2400',
  '1440x2960',
  '1440x3088',
  '1440x3200',
  // Desktop / laptop
  '1366x768',
  '1440x900',
  '1536x864',
  '1920x1080',
  '1920x1200',
  '2560x1440',
  '2560x1600',
  '2880x1800',
  '3024x1964',
  '3456x2234',
  '3840x2160',
];

export const DEFAULT_FILENAME_PATTERNS = [
  'Screenshot',
  'Screen Shot',
  'Bildschirmfoto',
  'Capture d’écran',
  'Schermafbeelding',
  'Screenshot_',
];

export const ScreenshotParams = z.object({
  threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.6)
    .describe('Minimum score (0–1) for an asset to match'),
  descriptionTags: z
    .array(z.string().min(1))
    .default(['Screenshot'])
    .describe(
      'Immich EXIF description values that mark a screenshot (iOS writes "Screenshot"); decisive',
    ),
  filenamePatterns: z
    .array(z.string().min(1))
    .default(DEFAULT_FILENAME_PATTERNS)
    .describe('File name contains any of these (case-insensitive), or /regex/'),
  screenResolutions: z
    .array(resolution)
    .default(DEFAULT_SCREEN_RESOLUTIONS)
    .describe('Screen sizes as WIDTHxHEIGHT, either orientation'),
  minAspectRatio: z
    .number()
    .min(1)
    .default(2)
    .describe(
      'Also count as screen-sized: long side / short side at least this, without camera EXIF',
    ),
  readIosTag: z
    .boolean()
    .default(true)
    .describe(
      'For borderline PNGs / images without camera EXIF: read the iOS "Screenshot" tag from the first 64 KB of the original (cached per file)',
    ),
  clip: z
    .object({
      enabled: z.boolean().default(false),
      queries: z
        .array(z.string().min(1))
        .default([
          'a screenshot of a phone screen',
          'a screenshot of a computer screen',
        ]),
      topN: z.number().int().min(1).max(10_000).default(2000),
    })
    .default({
      enabled: false,
      queries: [
        'a screenshot of a phone screen',
        'a screenshot of a computer screen',
      ],
      topN: 2000,
    })
    .describe(
      'Smart search (CLIP): assets in the top N of these queries get up to +0.25 (needs Immich machine learning)',
    ),
  includeArchived: z
    .boolean()
    .default(false)
    .describe('Also scan archived assets'),
});
export type ScreenshotParams = z.infer<typeof ScreenshotParams>;

export const DEFAULT_SCREENSHOT_PARAMS: ScreenshotParams =
  ScreenshotParams.parse({});

/** Signal weights (SDD §6.1). */
export const WEIGHTS = {
  filename: 0.6,
  png: 0.25,
  noCameraExif: 0.15,
  screenSize: 0.2,
  /** Maximum CLIP bonus (top hit); scaled down by rank. */
  clip: 0.25,
} as const;

export function parseResolution(r: string): [number, number] {
  const [w, h] = r.split('x').map(Number);
  return [w, h];
}
