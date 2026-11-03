import type { ProposedGroup } from '../core/job-type.js';
import type {
  GroupAction,
  GroupStatus,
} from '../persistence/entities/index.js';

/** A stored group as the reconciler needs it. */
export interface ExistingGroup {
  id: string;
  status: GroupStatus;
  coreStart: Date;
  coreEnd: Date;
  albumId: string | null;
  name: string;
  /** Assets in its album as the job knows them (`owned` + `present`). */
  assetIds: ReadonlySet<string>;
  /** Assets the job added (`owned`); the merge winner is the one with most. */
  ownedCount: number;
}

export interface ReconcileItem {
  action: GroupAction;
  /** Set for create / update / ignored / locked. */
  proposed?: ProposedGroup;
  /** Set for update / ignored / locked / orphaned / merged. */
  existing?: ExistingGroup;
  /** `merged`: the existing group that takes over. */
  mergedInto?: ExistingGroup;
}

/** Statuses that block a proposal: the user decided about this group. */
const BLOCKING: readonly GroupStatus[] = ['ignored', 'locked'];

const overlaps = (
  a: { coreStart: Date; coreEnd: Date },
  b: { coreStart: Date; coreEnd: Date },
) => a.coreStart <= b.coreEnd && b.coreStart <= a.coreEnd;

/**
 * Matches this run's proposed groups to the stored ones by overlap of their
 * core ranges (trip-albums SDD §7.2):
 *
 * - no overlap → `create`; stored group without a proposal → `orphaned`
 * - overlaps an `ignored` / `locked` group → skipped with that action
 * - otherwise, per connected set of overlapping groups, pairs are matched
 *   greedily by shared assets (then by stored assets added by the job): matched
 *   pairs → `update`, extra proposals (a split) → `create`, extra stored
 *   groups (a merge) → `merged` into the group that took over.
 *
 * Pure and deterministic. Items come out ordered by core start.
 */
export function reconcileGroups(
  proposed: readonly ProposedGroup[],
  existing: readonly ExistingGroup[],
): ReconcileItem[] {
  const items: ReconcileItem[] = [];
  const blockers = existing.filter((e) => BLOCKING.includes(e.status));
  const matchable = existing.filter((e) => !BLOCKING.includes(e.status));

  const open: ProposedGroup[] = [];
  for (const p of proposed) {
    const blocker = blockers
      .filter((b) => overlaps(p, b))
      // `locked` wins over `ignored`; then the earliest.
      .sort(
        (a, b) =>
          Number(b.status === 'locked') - Number(a.status === 'locked') ||
          +a.coreStart - +b.coreStart,
      )[0];
    if (blocker)
      items.push({
        action: blocker.status as 'ignored' | 'locked',
        proposed: p,
        existing: blocker,
      });
    else open.push(p);
  }

  for (const component of components(open, matchable)) {
    const { ps, es } = component;
    const pairs: { p: ProposedGroup; e: ExistingGroup; shared: number }[] = [];
    for (const p of ps)
      for (const e of es)
        if (overlaps(p, e))
          pairs.push({
            p,
            e,
            shared: p.assets.filter((a) => e.assetIds.has(a.assetId)).length,
          });
    pairs.sort(
      (a, b) =>
        b.shared - a.shared ||
        b.e.ownedCount - a.e.ownedCount ||
        +a.e.coreStart - +b.e.coreStart ||
        +a.p.coreStart - +b.p.coreStart,
    );
    const usedP = new Set<ProposedGroup>();
    const usedE = new Map<ExistingGroup, ProposedGroup>();
    for (const { p, e } of pairs) {
      if (usedP.has(p) || usedE.has(e)) continue;
      usedP.add(p);
      usedE.set(e, p);
      items.push({ action: 'update', proposed: p, existing: e });
    }
    for (const p of ps)
      if (!usedP.has(p)) items.push({ action: 'create', proposed: p });
    for (const e of es) {
      if (usedE.has(e)) continue;
      // Overlaps a proposal another stored group took → merged into that one.
      const winner = [...usedE.entries()].find(([, p]) => overlaps(p, e))?.[0];
      items.push(
        winner
          ? { action: 'merged', existing: e, mergedInto: winner }
          : { action: 'orphaned', existing: e },
      );
    }
  }

  return items.sort(
    (a, b) => +coreStartOf(a) - +coreStartOf(b) || rank(a) - rank(b),
  );
}

function coreStartOf(item: ReconcileItem): Date {
  return (item.proposed ?? item.existing!).coreStart;
}

const ORDER: GroupAction[] = [
  'update',
  'create',
  'ignored',
  'locked',
  'merged',
  'orphaned',
];
const rank = (item: ReconcileItem) => ORDER.indexOf(item.action);

/** Connected sets of proposed and stored groups linked by overlap. */
function components(
  ps: readonly ProposedGroup[],
  es: readonly ExistingGroup[],
): { ps: ProposedGroup[]; es: ExistingGroup[] }[] {
  const nodes = [
    ...ps.map((p) => ({ kind: 'p' as const, p })),
    ...es.map((e) => ({ kind: 'e' as const, e })),
  ];
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < ps.length; i++)
    for (let j = 0; j < es.length; j++)
      if (overlaps(ps[i], es[j])) parent[find(i)] = find(ps.length + j);

  const groups = new Map<
    number,
    { ps: ProposedGroup[]; es: ExistingGroup[] }
  >();
  nodes.forEach((n, i) => {
    const root = find(i);
    const g = groups.get(root) ?? { ps: [], es: [] };
    if (n.kind === 'p') g.ps.push(n.p);
    else g.es.push(n.e);
    groups.set(root, g);
  });
  return [...groups.values()];
}
