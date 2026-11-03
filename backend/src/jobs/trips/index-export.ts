import type {
  IndexedAsset,
  IndexType,
  IndexVisibility,
} from '../../asset-index/asset-index.mapping.js';

/** Owner id the tuning CLI uses for the user's own assets (partners: `partner`). */
export const EXPORT_OWNER = 'me';

/** Row of `tools/immich-spike` `out/trips-index.json` (format version 1). */
interface ExportRow {
  id: string;
  own: boolean;
  type: string;
  visibility: string;
  fileCreatedAt: string;
  localDateTime: string;
  timeZone: string | null;
  lat: number | null;
  lon: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  make: string | null;
  model: string | null;
  isScreenshot: boolean;
  fileName: string;
}

const blank = (v: string | null | undefined) => v == null || v.trim() === '';

/**
 * Reads the raw index export of `npm run trips` (spike) into index rows, the
 * same shape `AssetIndexService.read()` returns. Rows outside the index scope
 * (other types or visibilities, missing dates) are skipped.
 */
export function fromIndexExport(json: unknown): IndexedAsset[] {
  const data = json as { version?: number; assets?: ExportRow[] };
  if (data?.version !== 1 || !Array.isArray(data.assets))
    throw new Error(
      'Not a trips index export (expected {"version": 1, "assets": [...]} from tools/immich-spike npm run trips)',
    );
  const out: IndexedAsset[] = [];
  for (const r of data.assets) {
    if (r.type !== 'IMAGE' && r.type !== 'VIDEO') continue;
    if (r.visibility !== 'timeline' && r.visibility !== 'archive') continue;
    const takenAt = Date.parse(r.fileCreatedAt);
    const local = Date.parse(r.localDateTime);
    if (!Number.isFinite(takenAt) || !Number.isFinite(local)) continue;
    const gps = typeof r.lat === 'number' && typeof r.lon === 'number';
    out.push({
      id: r.id,
      ownerId: r.own ? EXPORT_OWNER : 'partner',
      type: r.type as IndexType,
      visibility: r.visibility as IndexVisibility,
      takenAt,
      localDateTime: new Date(local).toISOString().slice(0, -1),
      timeZone: blank(r.timeZone) ? null : r.timeZone,
      latitude: gps ? r.lat : null,
      longitude: gps ? r.lon : null,
      city: blank(r.city) ? null : r.city,
      state: blank(r.state) ? null : r.state,
      country: blank(r.country) ? null : r.country,
      hasCamera: !blank(r.make) || !blank(r.model),
      isScreenshot: r.isScreenshot === true,
      fileName: r.fileName,
    });
  }
  return out;
}
