import exifr from 'exifr';
import type { AssetFeatureCache } from '../../features/asset-feature-cache.js';
import type {
  AssetResponseDto,
  ImmichClient,
} from '../../immich/immich.client.js';
import type { RunLogger } from '../job-type.js';

/**
 * One shared options object on purpose: exifr caches parsed options per
 * options object, so a fresh literal per call leaks ~8 KB per file read
 * (found by the 100k scale test: +170 MB per 22k reads).
 */
const USER_COMMENT_ONLY = { pick: ['UserComment'] };

/** iOS/macOS write EXIF `UserComment = "Screenshot"` into every screenshot (SDD §6.2). */
export const IOS_SCREENSHOT_COMMENT = 'Screenshot';

/**
 * EXIF UserComment = 8-byte character code (`ASCII\0\0\0`, `UNICODE\0`, `JIS\0\0\0\0\0`,
 * or zeros) + payload. exifr returns raw bytes; some writers produce plain strings.
 */
export function decodeUserComment(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value.replace(/\0+$/, '').trim();
  if (!(value instanceof Uint8Array)) return undefined;
  const code = new TextDecoder('latin1')
    .decode(value.subarray(0, 8))
    .replace(/\0+$/, '');
  const body = value.subarray(8);
  const text =
    code === 'UNICODE'
      ? decodeUtf16(body)
      : new TextDecoder(
          code === 'ASCII' || code === '' ? 'utf-8' : 'latin1',
        ).decode(body);
  return text.replace(/\0+$/, '').trim();
}

function decodeUtf16(bytes: Uint8Array): string {
  // Byte order follows the TIFF header, which exifr does not return: guess from the zero bytes.
  const be = bytes.length > 1 && bytes[0] === 0;
  return new TextDecoder(be ? 'utf-16be' : 'utf-16le').decode(bytes);
}

/** Reads EXIF UserComment from the first 64 KiB of the original. Undefined if absent or unparsable. */
export async function readUserComment(
  immich: ImmichClient,
  assetId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const head = await immich.readOriginalHead(assetId, { signal });
  try {
    const tags = (await exifr.parse(head.data, USER_COMMENT_ONLY)) as
      { userComment?: unknown } | undefined;
    return decodeUserComment(tags?.userComment);
  } catch {
    return undefined; // not an image format exifr knows, or EXIF beyond the bytes read
  }
}

export interface TagLookupResult {
  /** Assets whose original carries the iOS screenshot tag. */
  tagged: Set<string>;
  filesRead: number;
  cacheHits: number;
  /** Reads that failed (Immich errors); not cached, retried next run. */
  failed: number;
}

/**
 * iOS screenshot tag for the given assets: from the feature cache when the
 * checksum is unchanged, else by reading the first 64 KiB of the original
 * (concurrency limited by `MAX_FILE_READS` in ImmichClient). Results are cached.
 */
export async function lookupIosScreenshotTags(
  assets: AssetResponseDto[],
  deps: {
    immich: ImmichClient;
    features: AssetFeatureCache;
    signal: AbortSignal;
    log: RunLogger;
  },
): Promise<TagLookupResult> {
  const result: TagLookupResult = {
    tagged: new Set(),
    filesRead: 0,
    cacheHits: 0,
    failed: 0,
  };
  if (assets.length === 0) return result;
  const cached = deps.features.getMany(
    assets.map((a) => ({ id: a.id, checksum: a.checksum })),
  );
  const toRead: AssetResponseDto[] = [];
  for (const a of assets) {
    const hit = cached.get(a.id)?.iosScreenshotTag;
    if (hit === undefined || hit === null) {
      toRead.push(a);
      continue;
    }
    result.cacheHits++;
    if (hit) result.tagged.add(a.id);
  }

  const learned: { id: string; checksum: string; iosScreenshotTag: boolean }[] =
    [];
  await Promise.all(
    toRead.map(async (a) => {
      try {
        const comment = await readUserComment(deps.immich, a.id, deps.signal);
        result.filesRead++;
        const tagged = comment === IOS_SCREENSHOT_COMMENT;
        if (tagged) result.tagged.add(a.id);
        learned.push({
          id: a.id,
          checksum: a.checksum,
          iosScreenshotTag: tagged,
        });
      } catch (e) {
        if (deps.signal.aborted) throw e;
        result.failed++;
        if (result.failed <= 3)
          deps.log.warn(
            `Could not read ${a.originalFileName} (${a.id}): ${(e as Error).message}`,
          );
      }
    }),
  );
  deps.signal.throwIfAborted();
  deps.features.setMany(learned);
  return result;
}
