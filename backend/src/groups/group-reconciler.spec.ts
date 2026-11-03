import type { ProposedGroup } from '../core/job-type.js';
import type { GroupStatus } from '../persistence/entities/index.js';
import { reconcileGroups, type ExistingGroup } from './group-reconciler.js';

const day = (d: number) => new Date(Date.UTC(2026, 0, d));

function proposed(
  key: string,
  from: number,
  to: number,
  assets: string[] = [],
): ProposedGroup {
  return {
    key,
    start: day(from),
    end: day(to),
    coreStart: day(from),
    coreEnd: day(to),
    ongoing: false,
    name: key,
    summary: {},
    assets: assets.map((assetId) => ({ assetId, reasons: [] })),
  };
}

function existing(
  id: string,
  from: number,
  to: number,
  assets: string[] = [],
  status: GroupStatus = 'active',
  ownedCount = assets.length,
): ExistingGroup {
  return {
    id,
    status,
    coreStart: day(from),
    coreEnd: day(to),
    albumId: `album-${id}`,
    name: id,
    assetIds: new Set(assets),
    ownedCount,
  };
}

const summary = (items: ReturnType<typeof reconcileGroups>) =>
  items.map((i) =>
    [
      i.action,
      i.proposed?.key ?? '-',
      i.existing?.id ?? '-',
      i.mergedInto?.id ?? '-',
    ].join(' '),
  );

describe('reconcileGroups', () => {
  it('creates proposals without a stored group', () => {
    expect(
      summary(
        reconcileGroups([proposed('a', 1, 5), proposed('b', 10, 12)], []),
      ),
    ).toEqual(['create a - -', 'create b - -']);
  });

  it('updates the overlapping stored group and orphans stored groups without a proposal', () => {
    const items = reconcileGroups(
      [proposed('a2', 2, 6)],
      [existing('A', 1, 5), existing('Z', 20, 22)],
    );
    expect(summary(items)).toEqual(['update a2 A -', 'orphaned - Z -']);
  });

  it('split: the proposal sharing most assets keeps the album, the other is new', () => {
    const items = reconcileGroups(
      [proposed('early', 1, 3, ['x']), proposed('late', 5, 9, ['y', 'z'])],
      [existing('A', 1, 9, ['x', 'y', 'z'])],
    );
    expect(summary(items)).toEqual(['create early - -', 'update late A -']);
  });

  it('merge: the stored group sharing most assets takes over, the other is merged', () => {
    const items = reconcileGroups(
      [proposed('ab', 1, 9, ['x', 'y', 'z'])],
      [existing('A', 1, 3, ['x']), existing('B', 5, 9, ['y', 'z'])],
    );
    expect(summary(items)).toEqual(['update ab B -', 'merged - A B']);
  });

  it('merge tie: the stored group with most owned assets takes over', () => {
    const items = reconcileGroups(
      [proposed('ab', 1, 9)],
      [
        existing('A', 1, 3, [], 'active', 2),
        existing('B', 5, 9, [], 'active', 7),
      ],
    );
    expect(summary(items)).toEqual(['update ab B -', 'merged - A B']);
  });

  it('skips proposals overlapping ignored or locked groups (locked first)', () => {
    const items = reconcileGroups(
      [proposed('a', 1, 5), proposed('b', 10, 12)],
      [
        existing('I', 2, 3, [], 'ignored'),
        existing('L', 4, 6, [], 'locked'),
        existing('I2', 11, 11, [], 'ignored'),
      ],
    );
    expect(summary(items)).toEqual(['locked a L -', 'ignored b I2 -']);
  });

  it('brings orphaned and merged groups back when detected again', () => {
    const items = reconcileGroups(
      [proposed('a', 1, 5)],
      [existing('O', 2, 3, [], 'orphaned')],
    );
    expect(summary(items)).toEqual(['update a O -']);
  });

  it('is deterministic regardless of input order', () => {
    const ps = [
      proposed('a', 1, 3, ['x']),
      proposed('b', 4, 9, ['y']),
      proposed('c', 20, 21),
    ];
    const es = [
      existing('A', 1, 9, ['x', 'y']),
      existing('B', 2, 5),
      existing('C', 30, 31),
    ];
    expect(
      summary(reconcileGroups([...ps].reverse(), [...es].reverse())),
    ).toEqual(summary(reconcileGroups(ps, es)));
  });
});
