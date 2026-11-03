import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AlbumJobType } from '../../core/album-job-type.decorator.js';
import { metadataSource } from '../../core/blocks/index.js';
import type {
  CandidateBatch,
  JobContext,
  JobType,
} from '../../core/job-type.js';
import { AssetTypeEnum, AssetVisibility } from '../../immich/immich.client.js';

const NoopTestParams = z.object({
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(1000)
    .describe('Assets per page (Immich metadata search)'),
  imagesOnly: z.boolean().default(false).describe('Only page through images'),
  includeArchived: z
    .boolean()
    .default(true)
    .describe('Include archived assets'),
});
export type NoopTestParams = z.infer<typeof NoopTestParams>;

/** Pages through the whole library and matches nothing. Exercises the runner end to end. */
@Injectable()
@AlbumJobType()
export class NoopTestJob implements JobType<NoopTestParams> {
  readonly id = 'noop-test';
  readonly name = 'No-op (test)';
  readonly description =
    'Pages through the whole library and matches nothing. For testing the runner.';
  readonly version = 1;
  readonly params = NoopTestParams;
  readonly defaultParams: NoopTestParams = {
    pageSize: 1000,
    imagesOnly: false,
    includeArchived: true,
  };

  async *select(
    ctx: JobContext<NoopTestParams>,
  ): AsyncIterable<CandidateBatch> {
    const { pageSize, imagesOnly, includeArchived } = ctx.params;
    const pages = metadataSource(
      ctx.immich,
      {
        size: pageSize,
        type: imagesOnly ? AssetTypeEnum.Image : undefined,
        visibility: includeArchived
          ? [AssetVisibility.Timeline, AssetVisibility.Archive]
          : [AssetVisibility.Timeline],
      },
      { resumeFrom: ctx.resumeFrom, since: ctx.since, signal: ctx.signal },
    );
    for await (const page of pages) {
      yield {
        candidates: [],
        scanned: page.assets.length,
        cursor: page.cursor,
      };
    }
  }
}
