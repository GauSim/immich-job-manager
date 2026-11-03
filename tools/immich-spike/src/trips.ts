/**
 * Phase T0 spike for the trip albums job (docs/design/trip-albums-SDD.md).
 *
 *   IMMICH_URL=http://immich_server:2283/api IMMICH_API_KEY=... npm run trips
 *
 * Read-only by default. Walks the whole library once (images + videos,
 * timeline + archive, with EXIF) and writes:
 *
 *   out/trips-stats.json   anonymised counts only (no ids, names, dates,
 *                          coordinates or places) – safe to commit to
 *                          docs/spike-out/
 *   out/trips-index.json   RAW per-asset index (GPS, places, times) for the
 *                          T2 tuning CLI. Private: never commit it (out/ is
 *                          git-ignored).
 *
 * Optional:
 *   TRIPS_OWNER_ID           your Immich user id, if the key lacks `user.read`
 *   TRIPS_PARTNER_ADD_TEST=1 adds one partner asset to the spike album and
 *                            removes it again (needs albumAsset.create/delete)
 *   SPIKE_ALBUM_NAME         test album for that (default "immich-album-jobs-spike")
 *   TRIPS_PAGE_SIZE          search page size (default 1000)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import {
  init,
  getServerVersion,
  getMyUser,
  getPartners,
  searchAssets,
  getAllAlbums,
  createAlbum,
  addAssetsToAlbum,
  removeAssetFromAlbum,
  isHttpError,
  AssetTypeEnum,
  AssetVisibility,
  AssetOrder,
  SearchOrderField,
  PartnerDirection,
  type AssetResponseDto,
} from '@immich/sdk';

const baseUrl = required('IMMICH_URL');
const apiKey = required('IMMICH_API_KEY');
const albumName = process.env.SPIKE_ALBUM_NAME || 'immich-album-jobs-spike';
const pageSize = Number(process.env.TRIPS_PAGE_SIZE || 1000);

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return v;
}

function describeError(e: unknown) {
  if (isHttpError(e)) return { status: e.status, message: (e.data as { message?: string })?.message };
  return { message: (e as Error).message };
}

/** One row of the raw export; the T2 tuning CLI reads this format (version 1). */
export interface IndexRow {
  id: string;
  own: boolean;
  type: 'IMAGE' | 'VIDEO' | string;
  visibility: string;
  /** Instant as Immich stores it (UTC). Wrong by the UTC offset when timeZone is null. */
  fileCreatedAt: string;
  /** Wall-clock time where the photo was taken, serialised with a fake `Z`. */
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
  deviceClass: DeviceClass;
  fileName: string;
}

type DeviceClass = 'screenshot' | 'phone' | 'camera' | 'none';

const PHONE_MAKES =
  /^(apple|google|samsung|xiaomi|redmi|poco|oneplus|huawei|honor|oppo|vivo|realme|motorola|nothing|fairphone|lge|lg electronics|nokia|hmd global|asus)\b/i;

function empty(v: string | null | undefined): boolean {
  return v == null || v.trim() === '';
}

export function deviceClass(a: AssetResponseDto): DeviceClass {
  const e = a.exifInfo;
  if (e?.description === 'Screenshot' || /screenshot|screen shot|bildschirmfoto/i.test(a.originalFileName))
    return 'screenshot';
  if (empty(e?.make) && empty(e?.model)) return 'none';
  const make = e?.make ?? '';
  const model = e?.model ?? '';
  if (/iphone|ipad|pixel|galaxy|xperia/i.test(model) || PHONE_MAKES.test(make)) return 'phone';
  if (/^sony$/i.test(make) && /^(XQ|SO-|J\d{4})/i.test(model)) return 'phone';
  return 'camera';
}

function toRow(a: AssetResponseDto, ownerId: string): IndexRow {
  const e = a.exifInfo;
  const lat = e?.latitude ?? null;
  const lon = e?.longitude ?? null;
  return {
    id: a.id,
    own: a.ownerId === ownerId,
    type: a.type,
    visibility: a.visibility,
    fileCreatedAt: a.fileCreatedAt,
    localDateTime: a.localDateTime,
    timeZone: e?.timeZone ?? null,
    lat,
    lon,
    city: e?.city ?? null,
    state: e?.state ?? null,
    country: e?.country ?? null,
    make: empty(e?.make) ? null : e!.make!,
    model: empty(e?.model) ? null : e!.model!,
    isScreenshot: e?.description === 'Screenshot',
    deviceClass: deviceClass(a),
    fileName: a.originalFileName,
  };
}

// ---------- anonymised statistics ----------

interface Bucket {
  total: number;
  gps: number;
  gpsWithCountry: number;
  gpsWithoutCountry: number;
  timeZoneNull: number;
  timeZoneNullWithGps: number;
  /** localDateTime − fileCreatedAt in hours → count. 0 with a null time zone means "instant = wall clock". */
  offsetHours: Record<string, number>;
  timeZoneFormat: Record<string, number>;
}

function bucket(): Bucket {
  return {
    total: 0,
    gps: 0,
    gpsWithCountry: 0,
    gpsWithoutCountry: 0,
    timeZoneNull: 0,
    timeZoneNullWithGps: 0,
    offsetHours: {},
    timeZoneFormat: {},
  };
}

function inc(r: Record<string, number>, k: string) {
  r[k] = (r[k] ?? 0) + 1;
}

function tzFormat(tz: string | null): string {
  if (tz == null) return 'null';
  if (/^UTC[+-]?\d/.test(tz) || tz === 'UTC+0') return 'utc-offset';
  if (/^[A-Za-z_]+\/[A-Za-z_/+-]+$/.test(tz)) return 'iana';
  return 'other';
}

function add(b: Bucket, r: IndexRow) {
  b.total++;
  const gps = r.lat != null && r.lon != null;
  if (gps) {
    b.gps++;
    if (r.country) b.gpsWithCountry++;
    else b.gpsWithoutCountry++;
  }
  if (r.timeZone == null) {
    b.timeZoneNull++;
    if (gps) b.timeZoneNullWithGps++;
  }
  inc(b.timeZoneFormat, tzFormat(r.timeZone));
  const off = (Date.parse(r.localDateTime) - Date.parse(r.fileCreatedAt)) / 3_600_000;
  if (Number.isFinite(off)) inc(b.offsetHours, String(Math.round(off * 4) / 4));
}

function localDay(r: IndexRow): string {
  return r.localDateTime.slice(0, 10);
}

/** Per local day: is there a GPS asset? Days with only camera photos without GPS are what the fill must cover. */
function dayCoverage(rows: IndexRow[]) {
  const days = new Map<string, { gps: boolean; phone: boolean; cameraNoGps: boolean }>();
  for (const r of rows) {
    if (!r.own || r.deviceClass === 'screenshot') continue;
    const d = days.get(localDay(r)) ?? { gps: false, phone: false, cameraNoGps: false };
    if (r.lat != null) d.gps = true;
    if (r.deviceClass === 'phone') d.phone = true;
    if (r.deviceClass === 'camera' && r.lat == null) d.cameraNoGps = true;
    days.set(localDay(r), d);
  }
  const v = [...days.values()];
  return {
    daysWithAssets: v.length,
    daysWithGps: v.filter((d) => d.gps).length,
    daysWithoutGps: v.filter((d) => !d.gps).length,
    daysWithCameraNoGpsButOtherGps: v.filter((d) => d.cameraNoGps && d.gps).length,
    daysWithCameraNoGpsAndNoGpsAtAll: v.filter((d) => d.cameraNoGps && !d.gps).length,
  };
}

/** Country distribution without names: how dominant is the most frequent country (≈ home)? */
function countryShape(rows: IndexRow[]) {
  const byDays = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.own || !r.country) continue;
    const s = byDays.get(r.country) ?? new Set<string>();
    s.add(localDay(r));
    byDays.set(r.country, s);
  }
  const counts = [...byDays.values()].map((s) => s.size).sort((a, b) => b - a);
  const total = counts.reduce((a, b) => a + b, 0);
  return {
    distinctCountries: counts.length,
    topCountryShareOfGpsDays: total ? +(counts[0] / total).toFixed(3) : null,
    countryDayCountsDesc: counts,
  };
}

function years(rows: IndexRow[]) {
  const y: Record<string, { total: number; gps: number }> = {};
  for (const r of rows) {
    if (!r.own) continue;
    const k = r.localDateTime.slice(0, 4);
    y[k] ??= { total: 0, gps: 0 };
    y[k].total++;
    if (r.lat != null) y[k].gps++;
  }
  return y;
}

// ---------- main ----------

async function main() {
  init({ baseUrl, apiKey });
  const stats: Record<string, unknown> = { startedAt: new Date().toISOString() };
  console.log(`Immich: ${baseUrl}`);

  const version = await getServerVersion();
  stats.serverVersion = `${version.major}.${version.minor}.${version.patch}`;

  // Who am I? Needed to tell own assets from partner assets (search has no owner filter in v3).
  let ownerId = process.env.TRIPS_OWNER_ID || '';
  let ownerIdSource = ownerId ? 'env' : '';
  try {
    const me = await getMyUser();
    ownerId ||= me.id;
    ownerIdSource ||= 'users/me';
    stats.userRead = { ok: true };
  } catch (e) {
    stats.userRead = { ok: false, error: describeError(e) };
  }

  try {
    const partners = await getPartners({ direction: PartnerDirection.SharedWith });
    stats.partners = {
      ok: true,
      sharedWithMe: partners.length,
      inTimeline: partners.filter((p) => p.inTimeline).length,
    };
  } catch (e) {
    stats.partners = { ok: false, error: describeError(e) };
  }

  // Walk the library.
  const raw: AssetResponseDto[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const t0 = Date.now();
  do {
    const res = await searchAssets({
      metadataSearchDto: {
        filter: {
          type: { in: [AssetTypeEnum.Image, AssetTypeEnum.Video] },
          visibility: { in: [AssetVisibility.Timeline, AssetVisibility.Archive] },
        },
        orderBy: { field: SearchOrderField.FileCreatedAt, direction: AssetOrder.Asc },
        withExif: true,
        size: pageSize,
        cursor,
      },
    });
    raw.push(...res.assets.items);
    cursor = res.assets.nextCursor ?? undefined;
    pages++;
    if (pages % 10 === 0) console.log(`  … ${raw.length} assets`);
  } while (cursor);
  stats.walk = { assets: raw.length, pages, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
  console.log(`✔ walked ${raw.length} assets in ${pages} pages`);

  if (!ownerId) {
    // Fall back to the most frequent owner (only wrong if the partner has more assets than you).
    const byOwner = new Map<string, number>();
    for (const a of raw) byOwner.set(a.ownerId, (byOwner.get(a.ownerId) ?? 0) + 1);
    ownerId = [...byOwner.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    ownerIdSource = 'most-frequent-owner';
  }
  stats.ownerIdSource = ownerIdSource;

  const rows = raw.map((a) => toRow(a, ownerId));
  const distinctIds = new Set(rows.map((r) => r.id)).size;
  stats.distinctIds = distinctIds;

  // Partner assets in search results (SDD open question 1).
  const partnerRows = rows.filter((r) => !r.own);
  const partnerVisibility: Record<string, number> = {};
  for (const r of partnerRows) inc(partnerVisibility, r.visibility);
  stats.partnerAssetsInSearch = {
    count: partnerRows.length,
    distinctOwners: new Set(raw.filter((a) => a.ownerId !== ownerId).map((a) => a.ownerId)).size,
    byVisibility: partnerVisibility,
  };

  // Coverage buckets: owner × type × device class (SDD open questions 2 and 3).
  const buckets: Record<string, Bucket> = {};
  for (const r of rows) {
    const key = `${r.own ? 'own' : 'partner'}/${r.type}/${r.deviceClass}`;
    buckets[key] ??= bucket();
    add(buckets[key], r);
  }
  stats.coverage = Object.fromEntries(Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b)));
  stats.dayCoverage = dayCoverage(rows);
  stats.countries = countryShape(rows);
  stats.years = years(rows);

  // Albums: are start/end dates in the list response (adoption pre-filter)?
  try {
    const albums = await getAllAlbums({});
    stats.albums = {
      ok: true,
      count: albums.length,
      owned: albums.filter((a) => a.albumUsers?.[0]?.user?.id === ownerId).length,
      withStartEnd: albums.filter((a) => a.startDate && a.endDate).length,
      withLastModifiedAssetTimestamp: albums.filter((a) => a.lastModifiedAssetTimestamp).length,
      nonEmpty: albums.filter((a) => a.assetCount > 0).length,
      managedByAlbumJobs: albums.filter((a) => a.description?.includes('Immich Album Jobs')).length,
      /** Span in days of non-empty albums → how many look like trips (2–60 days). */
      spanDays: albums
        .filter((a) => a.startDate && a.endDate)
        .map((a) => Math.round((Date.parse(a.endDate!) - Date.parse(a.startDate!)) / 86_400_000))
        .sort((a, b) => a - b),
    };
  } catch (e) {
    stats.albums = { ok: false, error: describeError(e) };
  }

  // Optional write test: can we add a partner asset to our own album?
  if (process.env.TRIPS_PARTNER_ADD_TEST === '1') {
    stats.partnerAddTest = await partnerAddTest(raw, ownerId);
  }

  stats.finishedAt = new Date().toISOString();
  await mkdir('out', { recursive: true });
  await writeFile('out/trips-stats.json', JSON.stringify(stats, null, 2));
  await writeFile(
    'out/trips-index.json',
    JSON.stringify({ version: 1, exportedAt: stats.finishedAt, assets: rows }),
  );
  console.log('\nanonymised stats → out/trips-stats.json (safe to share)');
  console.log('raw index → out/trips-index.json (PRIVATE: GPS and places, never commit)');
  summary(stats);
}

async function partnerAddTest(raw: AssetResponseDto[], ownerId: string) {
  const pick = (v: string) => raw.find((a) => a.ownerId !== ownerId && a.visibility === v)?.id;
  const ids = { timeline: pick('timeline'), archive: pick('archive') };
  if (!ids.timeline && !ids.archive) return { skipped: 'no partner assets in search results' };
  try {
    const all = await getAllAlbums({});
    const album =
      all.find((a) => a.albumName === albumName) ??
      (await createAlbum({ createAlbumDto: { albumName, description: 'Immich Album Jobs API spike' } }));
    const tryIds = [ids.timeline, ids.archive].filter((x): x is string => !!x);
    const added = await addAssetsToAlbum({ id: album.id, bulkIdsDto: { ids: tryIds } });
    const removed = await removeAssetFromAlbum({ id: album.id, bulkIdsDto: { ids: tryIds } });
    const label = (id: string) => (id === ids.timeline ? 'timeline' : 'archive');
    return {
      add: added.map((r) => ({ partnerAsset: label(r.id), success: r.success, error: r.error })),
      remove: removed.map((r) => ({ partnerAsset: label(r.id), success: r.success, error: r.error })),
    };
  } catch (e) {
    return { error: describeError(e) };
  }
}

function summary(s: Record<string, unknown>) {
  const cov = s.coverage as Record<string, Bucket>;
  console.log('\nGPS coverage (own assets):');
  for (const [k, b] of Object.entries(cov)) {
    if (!k.startsWith('own/')) continue;
    const pct = (n: number) => `${((100 * n) / Math.max(b.total, 1)).toFixed(0)}%`;
    console.log(
      `  ${k.padEnd(24)} ${String(b.total).padStart(7)}  gps ${pct(b.gps).padStart(4)}  tz-null ${pct(b.timeZoneNull).padStart(4)}`,
    );
  }
  console.log(`partner assets in search: ${JSON.stringify(s.partnerAssetsInSearch)}`);
  console.log(`days: ${JSON.stringify(s.dayCoverage)}`);
}

await main();
