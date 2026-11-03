import {
  aspectRatioAtLeast,
  dimensionsIn,
  exifScorer,
  filenameScorer,
  hasNoCameraExif,
  mimeTypeIs,
  scoreAsset,
  type Scorer,
  type ScoreResult,
} from '../../core/blocks/index.js';
import type { AssetResponseDto } from '../../immich/immich.client.js';
import {
  parseResolution,
  WEIGHTS,
  type ScreenshotParams,
} from './screenshot.params.js';

export const REASONS = {
  descriptionTag: 'description-tag',
  filename: 'filename',
  png: 'png',
  noCameraExif: 'no-camera-exif',
  screenSize: 'screen-size',
} as const;

/**
 * Immich's `exifInfo.description` of real iPhone screenshots is "Screenshot"
 * (verified on the real library, docs/immich-api-notes.md §4.2). Decisive, like
 * the iOS tag in the file — but free, because it comes with the metadata.
 */
export function descriptionTagScorer(tags: string[]): Scorer {
  const wanted = new Set(tags.map((t) => t.trim().toLowerCase()));
  return (asset) => {
    const d = asset.exifInfo?.description?.trim().toLowerCase();
    return d && wanted.has(d)
      ? { score: 1, reason: REASONS.descriptionTag, decisive: true }
      : null;
  };
}

/** Metadata-only scorers for the screenshot job (SDD §6.1). */
export function buildScreenshotScorers(params: ScreenshotParams): Scorer[] {
  const resolutions = params.screenResolutions.map(parseResolution);
  const screenSized = dimensionsIn(resolutions);
  const tall = aspectRatioAtLeast(params.minAspectRatio);
  return [
    descriptionTagScorer(params.descriptionTags),
    filenameScorer(params.filenamePatterns, {
      score: WEIGHTS.filename,
      reason: REASONS.filename,
    }),
    exifScorer([
      {
        reason: REASONS.png,
        score: WEIGHTS.png,
        test: mimeTypeIs('image/png'),
      },
      {
        reason: REASONS.noCameraExif,
        score: WEIGHTS.noCameraExif,
        test: hasNoCameraExif,
      },
      {
        reason: REASONS.screenSize,
        score: WEIGHTS.screenSize,
        test: (a) => screenSized(a) || (hasNoCameraExif(a) && tall(a)),
      },
    ]),
  ];
}

export function scoreScreenshot(
  asset: AssetResponseDto,
  scorers: Scorer[],
): ScoreResult {
  return scoreAsset(asset, scorers);
}
