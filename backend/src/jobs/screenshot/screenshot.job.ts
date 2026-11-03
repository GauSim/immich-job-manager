import { Injectable } from '@nestjs/common';
import { AlbumJobType } from '../../core/album-job-type.decorator.js';
import { metadataSource, scoreAsset } from '../../core/blocks/index.js';
import type {
  Candidate,
  CandidateBatch,
  JobContext,
  JobType,
} from '../../core/job-type.js';
import { AssetTypeEnum, AssetVisibility } from '../../immich/immich.client.js';
import {
  DEFAULT_SCREENSHOT_PARAMS,
  ScreenshotParams,
} from './screenshot.params.js';
import { buildScreenshotScorers } from './screenshot.scoring.js';

/**
 * Finds screenshots (images only) from metadata signals: Immich description
 * tag, file name, PNG, no camera EXIF, screen dimensions (SDD §6).
 */
@Injectable()
@AlbumJobType()
export class ScreenshotJob implements JobType<ScreenshotParams> {
  readonly id = 'screenshot-detector';
  readonly name = 'Screenshots';
  readonly description =
    'Finds screenshots from metadata: iOS "Screenshot" description, file name, PNG, missing camera EXIF and screen-sized dimensions.';
  readonly version = 1;
  readonly params = ScreenshotParams;
  readonly defaultParams = DEFAULT_SCREENSHOT_PARAMS;

  async *select(
    ctx: JobContext<ScreenshotParams>,
  ): AsyncIterable<CandidateBatch> {
    const p = ctx.params;
    if (p.readIosTag)
      ctx.log.warn(
        'readIosTag is not active yet (phase 6); using metadata signals only',
      );
    if (p.clip.enabled)
      ctx.log.warn('The CLIP signal is not active yet (phase 6); ignoring it');

    const scorers = buildScreenshotScorers(p);
    const reasonCounts = new Map<string, number>();
    const visibility = p.includeArchived
      ? [AssetVisibility.Timeline, AssetVisibility.Archive]
      : [AssetVisibility.Timeline];

    const pages = metadataSource(
      ctx.immich,
      { type: AssetTypeEnum.Image, visibility, withExif: true },
      { resumeFrom: ctx.resumeFrom, since: ctx.since, signal: ctx.signal },
    );
    for await (const page of pages) {
      const candidates: Candidate[] = [];
      for (const asset of page.assets) {
        const { score, reasons } = scoreAsset(asset, scorers);
        if (score < p.threshold) continue;
        candidates.push({
          assetId: asset.id,
          score,
          reasons,
          fileName: asset.originalFileName,
        });
        for (const r of reasons)
          reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
      }
      yield { candidates, scanned: page.assets.length, cursor: page.cursor };
    }
    if (reasonCounts.size > 0) {
      const summary = [...reasonCounts]
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${r} ${n}`)
        .join(', ');
      ctx.log.info(
        `Matches by signal${ctx.resumeFrom ? ' (since resume)' : ''}: ${summary}`,
      );
    }
  }
}
