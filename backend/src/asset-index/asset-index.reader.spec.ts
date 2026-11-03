import type { IndexedAsset } from './asset-index.mapping.js';
import { AssetIndexReader, matchesFilter } from './asset-index.reader.js';

function asset(
  id: string,
  takenAt: number,
  extra: Partial<IndexedAsset> = {},
): IndexedAsset {
  return {
    id,
    ownerId: 'me',
    type: 'IMAGE',
    visibility: 'timeline',
    takenAt,
    localDateTime: new Date(takenAt).toISOString().slice(0, -1),
    timeZone: 'UTC',
    latitude: null,
    longitude: null,
    city: null,
    state: null,
    country: null,
    hasCamera: true,
    isScreenshot: false,
    fileName: `${id}.jpg`,
    ...extra,
  };
}

describe('AssetIndexReader', () => {
  const reader = new AssetIndexReader([
    asset('c', 30),
    asset('a', 10),
    asset('b2', 20),
    asset('b1', 20),
    asset('d', 40),
  ]);

  it('orders by takenAt, then id', () => {
    expect(reader.all().map((a) => a.id)).toEqual(['a', 'b1', 'b2', 'c', 'd']);
    expect(reader.size).toBe(5);
  });

  it('returns a half-open time range', () => {
    expect(reader.between(20, 40).map((a) => a.id)).toEqual(['b1', 'b2', 'c']);
    expect(reader.between(new Date(0), new Date(11)).map((a) => a.id)).toEqual([
      'a',
    ]);
    expect(reader.between(41, 100)).toEqual([]);
    expect(reader.between(30, 30)).toEqual([]);
  });
});

describe('matchesFilter', () => {
  const own = asset('own', 1);
  const ownArchived = asset('own-a', 1, { visibility: 'archive' });
  const partner = asset('p', 1, { ownerId: 'partner' });
  const partnerArchived = asset('p-a', 1, {
    ownerId: 'partner',
    visibility: 'archive',
  });
  const video = asset('v', 1, { type: 'VIDEO' });
  const all = [own, ownArchived, partner, partnerArchived, video];
  const ids = (filter: Parameters<typeof matchesFilter>[1]) =>
    all.filter((a) => matchesFilter(a, filter)).map((a) => a.id);

  it('reads own timeline images and videos by default', () => {
    expect(ids({ ownerId: 'me' })).toEqual(['own', 'v']);
  });

  it('adds own archived assets when asked', () => {
    expect(ids({ ownerId: 'me', includeArchived: true })).toEqual([
      'own',
      'own-a',
      'v',
    ]);
  });

  it("adds partners' timeline assets, never their archived ones", () => {
    expect(
      ids({ ownerId: 'me', includePartners: true, includeArchived: true }),
    ).toEqual(['own', 'own-a', 'p', 'v']);
  });

  it('filters by type', () => {
    expect(ids({ ownerId: 'me', types: ['VIDEO'] })).toEqual(['v']);
  });
});
