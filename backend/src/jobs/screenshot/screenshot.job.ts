import { Injectable } from '@nestjs/common';
import { AlbumJobType } from '../../core/album-job-type.decorator.js';
import {
  hasNoCameraExif,
  lookupIosScreenshotTags,
  metadataSource,
  mimeTypeIs,
  rankScorer,
  scoreAsset,
  smartSource,
} from '../../core/blocks/index.js';
import type {
  Candidate,
  CandidateBatch,
  JobContext,
  JobType,
} from '../../core/job-type.js';
import {
  AssetTypeEnum,
  AssetVisibility,
  type AssetResponseDto,
} from '../../immich/immich.client.js';
import {
  DEFAULT_SCREENSHOT_PARAMS,
  ScreenshotParams,
  WEIGHTS,
} from './screenshot.params.js';
import { buildScreenshotScorers, REASONS } from './screenshot.scoring.js';

/**
 * Finds screenshots (images only): Immich description tag, file name, PNG,
 * no camera EXIF, screen dimensions (SDD §6.1), the iOS tag read from the
 * original for borderline assets (§6.2, cached per checksum) and optional CLIP.
 */
@Injectable()
@AlbumJobType()
export class ScreenshotJob implements JobType<ScreenshotParams> {
  readonly id = 'screenshot-detector';
  readonly name = 'Screenshots';
  readonly description =
    'Finds screenshots: iOS "Screenshot" description or file tag, file name, PNG, missing camera EXIF, screen-sized dimensions and (optionally) CLIP.';
  readonly version = 2; // 2: iOS tag from files, CLIP
  readonly params = ScreenshotParams;
  readonly defaultParams = DEFAULT_SCREENSHOT_PARAMS;

  async *select(
    ctx: JobContext<ScreenshotParams>,
  ): AsyncIterable<CandidateBatch> {
    const p = ctx.params;
    const scorers = buildScreenshotScorers(p);

    // CLIP: one smart search per query, once per run (SDD §6.4 step 3).
    if (p.clip.enabled) {
      const ranks = await smartSource(ctx.immich, p.clip.queries, {
        topN: p.clip.topN,
        type: AssetTypeEnum.Image,
        signal: ctx.signal,
        log: ctx.log,
      });
      if (ranks.size > 0) {
        ctx.log.info(
          `CLIP: ${ranks.size} assets ranked by ${p.clip.queries.length} queries`,
        );
        scorers.push(
          rankScorer(ranks, {
            topN: p.clip.topN,
            weight: WEIGHTS.clip,
            reason: REASONS.clip,
          }),
        );
      }
    }

    const reasonCounts = new Map<string, number>();
    const totals = { filesRead: 0, cacheHits: 0, failed: 0 };
    const visibility = p.includeArchived
      ? [AssetVisibility.Timeline, AssetVisibility.Archive]
      : [AssetVisibility.Timeline];

    const pages = metadataSource(
      ctx.immich,
      { type: AssetTypeEnum.Image, visibility, withExif: true },
      { resumeFrom: ctx.resumeFrom, since: ctx.since, signal: ctx.signal },
    );
    for await (const page of pages) {
      const scored = page.assets.map((asset) => ({
        asset,
        ...scoreAsset(asset, scorers),
      }));

      // iOS tag from the file, only where it can change the outcome (SDD §6.2).
      let tagged = new Set<string>();
      let filesRead = 0;
      let cacheHits = 0;
      if (p.readIosTag) {
        const borderline = scored
          .filter((s) => s.score < p.threshold && needsFileTag(s.asset))
          .map((s) => s.asset);
        const lookup = await lookupIosScreenshotTags(borderline, ctx);
        ({ tagged, filesRead, cacheHits } = lookup);
        totals.filesRead += filesRead;
        totals.cacheHits += cacheHits;
        totals.failed += lookup.failed;
      }

      const candidates: Candidate[] = [];
      for (const s of scored) {
        const score = tagged.has(s.asset.id) ? 1 : s.score;
        const reasons = tagged.has(s.asset.id)
          ? [REASONS.iosTag, ...s.reasons]
          : s.reasons;
        if (score < p.threshold) continue;
        candidates.push({
          assetId: s.asset.id,
          score,
          reasons,
          fileName: s.asset.originalFileName,
        });
        for (const r of reasons)
          reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
      }
      yield {
        candidates,
        scanned: page.assets.length,
        cursor: page.cursor,
        filesRead,
        cacheHits,
      };
    }

    const since = ctx.resumeFrom ? ' (since resume)' : '';
    if (reasonCounts.size > 0) {
      const summary = [...reasonCounts]
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${r} ${n}`)
        .join(', ');
      ctx.log.info(`Matches by signal${since}: ${summary}`);
    }
    if (p.readIosTag) {
      ctx.log.info(
        `iOS tag${since}: ${totals.filesRead} files read, ${totals.cacheHits} from cache` +
          (totals.failed
            ? `, ${totals.failed} unreadable (retried next run)`
            : ''),
      );
    }
  }
}

/**
 * Only images that could be untagged screenshots: PNGs or images without
 * camera EXIF. Assets with Immich's description tag never get here (score 1).
 */
export function needsFileTag(asset: AssetResponseDto): boolean {
  return mimeTypeIs('image/png')(asset) || hasNoCameraExif(asset);
}
