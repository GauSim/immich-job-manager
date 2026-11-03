import type { AlbumSummary } from '../immich/immich.client.js';

/** Description prefix of albums this app creates; such albums are never adopted. */
export const MANAGED_DESCRIPTION = 'Managed by Immich Album Jobs';

const DAY_MS = 86_400_000;

export interface AdoptionCandidate {
  key: string;
  start: Date;
  end: Date;
  assetIds: readonly string[];
}

export interface Adoption {
  albumId: string;
  albumName: string;
  /** Share of the album's assets that lie within the group. */
  share: number;
  /** Share of the group's assets already in the album. */
  coverage: number;
}

export interface AdoptionOptions {
  /** Min share of the album's assets inside the group's range (default from params, e.g. 0.8). */
  minShare: number;
  /** Min share of the group's assets already in the album (SDD §7.4: 0.3). */
  minCoverage: number;
}

/**
 * Finds existing albums that already cover new groups (trip-albums SDD §7.4).
 * A cheap pre-filter on the album's `startDate`/`endDate` (from the album list)
 * avoids reading members of unrelated albums. Each album is adopted at most
 * once, best coverage first.
 *
 * @param takenAt instant (ms) of an indexed asset, undefined if unknown
 */
export async function findAdoptions(
  groups: readonly AdoptionCandidate[],
  albums: readonly AlbumSummary[],
  managed: ReadonlySet<string>,
  listMembers: (albumId: string) => Promise<string[]>,
  takenAt: (assetId: string) => number | undefined,
  options: AdoptionOptions,
): Promise<Map<string, Adoption>> {
  const usable = albums.filter(
    (a) =>
      !managed.has(a.id) &&
      !a.description.startsWith(MANAGED_DESCRIPTION) &&
      a.assetCount > 0 &&
      a.startDate &&
      a.endDate,
  );
  const members = new Map<string, Promise<string[]>>();
  const membersOf = (id: string) => {
    let m = members.get(id);
    if (!m) {
      m = listMembers(id);
      members.set(id, m);
    }
    return m;
  };

  const pairs: { key: string; adoption: Adoption }[] = [];
  for (const g of groups) {
    if (g.assetIds.length === 0) continue;
    // Album dates are local times serialised as UTC: allow a day of slack.
    const from = g.start.getTime() - DAY_MS;
    const to = g.end.getTime() + DAY_MS;
    const wanted = new Set(g.assetIds);
    for (const album of usable) {
      const aStart = Date.parse(album.startDate!);
      const aEnd = Date.parse(album.endDate!);
      if (aStart < from || aEnd > to) continue; // the album must lie within the group
      const ids = await membersOf(album.id);
      if (ids.length === 0) continue;
      let inside = 0;
      let shared = 0;
      for (const id of ids) {
        if (wanted.has(id)) {
          shared++;
          inside++;
        } else {
          const t = takenAt(id);
          if (t !== undefined && t >= g.start.getTime() && t <= g.end.getTime())
            inside++;
        }
      }
      const share = inside / ids.length;
      const coverage = shared / wanted.size;
      if (share >= options.minShare && coverage >= options.minCoverage)
        pairs.push({
          key: g.key,
          adoption: {
            albumId: album.id,
            albumName: album.name,
            share,
            coverage,
          },
        });
    }
  }

  pairs.sort(
    (a, b) =>
      b.adoption.coverage - a.adoption.coverage ||
      b.adoption.share - a.adoption.share ||
      (a.key < b.key ? -1 : 1),
  );
  const out = new Map<string, Adoption>();
  const taken = new Set<string>();
  for (const { key, adoption } of pairs) {
    if (out.has(key) || taken.has(adoption.albumId)) continue;
    out.set(key, adoption);
    taken.add(adoption.albumId);
  }
  return out;
}
