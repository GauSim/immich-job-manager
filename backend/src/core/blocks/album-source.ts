import type { ImmichClient } from '../../immich/immich.client.js';

/** Current members of an album, e.g. the exclusion album. */
export async function albumSource(
  immich: ImmichClient,
  albumId: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  return new Set(await immich.listAlbumMemberIds(albumId, { signal }));
}
