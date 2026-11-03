import type { AlbumSummary } from '../immich/immich.client.js';
import { uniqueName } from '../sync/group-album-sync.js';
import { findAdoptions, MANAGED_DESCRIPTION } from './adoption.js';

const day = (d: number) => new Date(Date.UTC(2026, 2, d));

function album(
  id: string,
  from: number,
  to: number,
  extra: Partial<AlbumSummary> = {},
): AlbumSummary {
  return {
    id,
    name: `Album ${id}`,
    description: '',
    assetCount: 10,
    startDate: day(from).toISOString(),
    endDate: day(to).toISOString(),
    ...extra,
  };
}

describe('findAdoptions', () => {
  const trip = {
    key: 't',
    start: day(4),
    end: day(18),
    assetIds: ['a', 'b', 'c', 'd'],
  };
  const members: Record<string, string[]> = {
    good: ['a', 'b', 'x'], // x lies within the trip
    tooFew: ['a'], // coverage 25 %
    mixed: ['a', 'b', 'old', 'older'], // half outside the trip
    managed: ['a', 'b', 'c'],
  };
  const takenAt = (id: string) =>
    id === 'x'
      ? +day(10)
      : id.startsWith('old')
        ? +day(1) - 30 * 86_400_000
        : undefined;
  const run = (albums: AlbumSummary[], managed = new Set<string>()) =>
    findAdoptions(
      [trip],
      albums,
      managed,
      async (id) => members[id] ?? [],
      takenAt,
      {
        minShare: 0.8,
        minCoverage: 0.3,
      },
    );

  it('adopts an album mostly within the trip that covers enough of it', async () => {
    const res = await run([album('good', 5, 12)]);
    expect(res.get('t')).toMatchObject({
      albumId: 'good',
      share: 1,
      coverage: 0.5,
    });
  });

  it('skips albums covering too little, reaching outside, managed or empty', async () => {
    const res = await run(
      [
        album('tooFew', 5, 12),
        album('mixed', 5, 12),
        album('outside', 1, 30),
        album('managed', 5, 12),
        album('ours', 5, 12, { description: `${MANAGED_DESCRIPTION} – Trips` }),
        album('empty', 5, 12, { assetCount: 0 }),
      ],
      new Set(['managed']),
    );
    expect(res.size).toBe(0);
  });

  it('adopts each album at most once', async () => {
    const res = await findAdoptions(
      [trip, { ...trip, key: 't2' }],
      [album('good', 5, 12)],
      new Set(),
      async (id) => members[id] ?? [],
      takenAt,
      { minShare: 0.8, minCoverage: 0.3 },
    );
    expect([...res.keys()]).toEqual(['t']);
  });
});

describe('uniqueName', () => {
  it('appends a counter when the name is taken', () => {
    expect(uniqueName('Italy', new Set())).toBe('Italy');
    expect(uniqueName('Italy', new Set(['Italy', 'Italy (2)']))).toBe(
      'Italy (3)',
    );
  });
});
