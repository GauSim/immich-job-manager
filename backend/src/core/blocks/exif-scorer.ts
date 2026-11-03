import type { AssetResponseDto } from '../../immich/immich.client.js';
import type { Scorer } from './score.js';

export interface ExifRule {
  reason: string;
  score: number;
  test: (asset: AssetResponseDto) => boolean;
}

/** Adds each matching rule's score. */
export function exifScorer(rules: ExifRule[]): Scorer {
  return (asset) =>
    rules
      .filter((r) => r.test(asset))
      .map(({ reason, score }) => ({ reason, score }));
}

const isEmpty = (v: unknown) =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** True when make, model, lens, exposure time and f-number are all empty (`null` and `""` count as empty). */
export function hasNoCameraExif(asset: AssetResponseDto): boolean {
  const e = asset.exifInfo;
  if (!e) return true;
  return [e.make, e.model, e.lensModel, e.exposureTime, e.fNumber].every(
    isEmpty,
  );
}

/** MIME type of the original, e.g. `image/png`. */
export function mimeTypeIs(...types: string[]) {
  const wanted = types.map((t) => t.toLowerCase());
  return (asset: AssetResponseDto) =>
    wanted.includes((asset.originalMimeType ?? '').toLowerCase());
}

/** Pixel dimensions from the asset, falling back to EXIF. */
export function dimensions(
  asset: AssetResponseDto,
): { width: number; height: number } | null {
  const width = asset.width ?? asset.exifInfo?.exifImageWidth ?? null;
  const height = asset.height ?? asset.exifInfo?.exifImageHeight ?? null;
  return width && height ? { width, height } : null;
}

/** Width × height equals one of the resolutions, in either orientation. */
export function dimensionsIn(resolutions: [number, number][]) {
  return (asset: AssetResponseDto) => {
    const d = dimensions(asset);
    return (
      !!d &&
      resolutions.some(
        ([w, h]) =>
          (d.width === w && d.height === h) ||
          (d.width === h && d.height === w),
      )
    );
  };
}

/** Long side / short side ≥ ratio. */
export function aspectRatioAtLeast(ratio: number) {
  return (asset: AssetResponseDto) => {
    const d = dimensions(asset);
    return (
      !!d && Math.max(d.width, d.height) / Math.min(d.width, d.height) >= ratio
    );
  };
}

export const allOf =
  (...tests: ((a: AssetResponseDto) => boolean)[]) =>
  (asset: AssetResponseDto) =>
    tests.every((t) => t(asset));
