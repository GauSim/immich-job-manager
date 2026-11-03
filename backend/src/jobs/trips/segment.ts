import type { IndexedAsset } from '../../asset-index/asset-index.mapping.js';
import { hours } from './geo-time.js';

export interface Segment {
  /** Away points in instant order (≥ 1). */
  away: IndexedAsset[];
  /** Why it ended: a home stay, a gap without photos away, or the end of the library. */
  closedBy: 'home-stay' | 'gap' | 'end';
}

/**
 * Splits GPS points (instant order) into runs of time away (SDD §5.3).
 * A run ends when home points span ≥ `homeStayHours` or the next away point is
 * more than `maxGapHours` after the last one. A single home point in between
 * (e.g. a wrongly geotagged photo) does not end it.
 */
export function segment(
  gps: readonly IndexedAsset[],
  away: (a: IndexedAsset) => boolean,
  options: { maxGapHours: number; homeStayHours: number },
): Segment[] {
  const maxGap = hours(options.maxGapHours);
  const homeStay = hours(options.homeStayHours);
  const out: Segment[] = [];
  let open: IndexedAsset[] | null = null;
  let homeSince: number | null = null;

  const close = (closedBy: Segment['closedBy']) => {
    if (open) out.push({ away: open, closedBy });
    open = null;
    homeSince = null;
  };

  for (const p of gps) {
    if (away(p)) {
      if (open && p.takenAt - open[open.length - 1].takenAt > maxGap)
        close('gap');
      if (!open) open = [];
      open.push(p);
      homeSince = null;
    } else if (open) {
      homeSince ??= p.takenAt;
      if (p.takenAt - homeSince >= homeStay) close('home-stay');
    }
  }
  close('end');
  return out;
}
