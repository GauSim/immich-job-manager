import type {
  AssetResponseDto,
  ImmichClient,
  MetadataPageQuery,
} from '../../immich/immich.client.js';

export interface SourcePage {
  assets: AssetResponseDto[];
  /** Resume point after this page; null on the last page. */
  cursor: string | null;
}

export interface MetadataSourceOptions {
  /** Cursor to continue from (resume). */
  resumeFrom?: string;
  /** Incremental runs: only assets updated after this time. */
  since?: Date;
  signal?: AbortSignal;
}

/**
 * Pages lazily through `POST /search/metadata` with any filter.
 * The next page is only requested once the consumer asks for it.
 */
export async function* metadataSource(
  immich: ImmichClient,
  query: Omit<MetadataPageQuery, 'cursor'>,
  options: MetadataSourceOptions = {},
): AsyncGenerator<SourcePage> {
  let cursor = options.resumeFrom;
  const updatedAfter = options.since ?? query.updatedAfter;
  do {
    options.signal?.throwIfAborted();
    const page = await immich.searchMetadataPage(
      { ...query, updatedAfter, cursor },
      { signal: options.signal },
    );
    yield { assets: page.items, cursor: page.nextCursor };
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}
