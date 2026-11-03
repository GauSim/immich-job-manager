# Trip Albums – Software Design Document

| | |
| --- | --- |
| Version | 0.1 |
| Date | 2026-11-03 |
| Owner | Simon |
| Status | Draft for review |
| Extends | `immich-album-jobs-SDD.md` v1.0 |
| Plan | `trip-albums-implementation-plan.md` |

---

## 1. Purpose and scope

A new job type, **Trip albums** (`trip-albums`), finds holiday trips in the library and keeps **one Immich album per trip**. A trip is detected from the date and location of photos and videos. Assets without a location are included when they fall into a trip's time range. You configure the job once and give it a schedule. Each run then creates albums for new trips and updates existing ones, including a trip that is still going on.

This is the first job that writes to **many albums**, and the first that judges assets **as a group** (a cluster in time and space) rather than one asset at a time. Most of the design work is therefore a generic **group job** extension of the core. Trip detection is one implementation of it.

### 1.1 Goals

- Detect trips abroad automatically, with no manual home location. Domestic trips can be turned on by configuration.
- Include the travel days: the album starts with the departure (e.g. photos at Berlin airport) and ends with the arrival home.
- Pull camera photos without GPS into the trip they were taken on.
- One album per trip, named from a template. The job keeps it current on every scheduled run.
- Respect manual edits in Immich: renamed albums, photos removed by hand, photos added by hand.
- Reuse hand-made trip albums that already exist instead of creating duplicates.
- Preview the detected trips in a dry run before anything is written.

### 1.2 Non-goals

- No geocoding service and no point-of-interest data. City, state and country come from Immich's own reverse lookup.
- No changes to assets: no setting of dates, locations or descriptions.
- No deleting of albums, ever. A trip that disappears leaves its album alone and is flagged.
- Not a general "events" or "moments" clusterer (birthdays, parties at home). The group framework allows it later.

### 1.3 Decisions from the requirements interview (2026-11-03)

| Topic | Decision |
| --- | --- |
| Home | Inferred automatically from the library, over a rolling window, so moving house is handled. |
| What counts as a trip | Configurable. **Default: time spent in another country.** A distance rule for domestic trips is optional. |
| Travel days | Included: the album starts at departure (airport) and ends on arrival home. |
| Assets without GPS | Camera photos only (camera EXIF present). No screenshots, no messenger or app images. |
| Videos | Included. |
| Several countries in one trip | One album per trip (continuous time away). |
| Album name | Template param with placeholders. |
| Manual edits | Renames are kept. Removed assets stay out. Added assets are never removed. |
| Trip changes on rerun | Album updated in place. A vanished trip is flagged; its album is never deleted. |
| Existing hand-made albums | Adopted when they overlap a detected trip strongly (only adds, never removes or renames). |
| Ongoing trip | Album is created once the trip qualifies and grows on every scheduled run. |
| Review | Dry run shows a **trip list**. Trips can be unticked before apply. |
| Scope | Assets shared by a partner are included (T0: possible for the partner's timeline assets). Archived assets are off by default. |
| Operation | Configured once and scheduled. Runs create and update albums with no interaction. |

### 1.4 Terms

| Term | Meaning |
| --- | --- |
| Group job | A job type that returns **groups** of assets; each group is synced to its own album. |
| Group | One detected unit (here: a trip). Has a key, a time range, a summary and assets. |
| Asset index | Local table with the few metadata fields grouping needs, for every asset in the library. |
| Home | Where you live at a given time: a country plus a home location (roughly 1 km). Inferred per date. |
| Away point | An asset with GPS that the away rule classifies as "not at home". |
| Core range | First to last away point of a trip. |
| Trip range | Core range plus the departure and return transit. This is what the album covers. |
| Fill | Assets without GPS (or in transit) that join a trip because of their time. |

---

## 2. Data available from Immich

All from `POST /search/metadata` with `withExif: true` (API notes §4). No extra calls per asset.

| Field | Use |
| --- | --- |
| `exifInfo.latitude`, `.longitude` | Away rule, home location, travel speed. `null` for many assets (screenshots, messenger images, some cameras). |
| `exifInfo.city`, `.state`, `.country` | Away rule (country), album name, summary. Immich fills these from GPS (offline reverse geocoding). The names are as Immich stores them; no translation. |
| `fileCreatedAt` | The capture **instant** (UTC). Used for ordering, gaps and speed. |
| `localDateTime` | Wall-clock time where the photo was taken. Used for calendar days, nights and names. |
| `exifInfo.timeZone` | Sanity check between the two. |
| `exifInfo.make`, `.model` | "Camera photo" test for the no-GPS fill. |
| `exifInfo.description` | `"Screenshot"` marks iOS screenshots (never filled into trips). |
| `type`, `visibility`, `ownerId`, `updatedAt` | Videos on/off, archived on/off, partner assets, incremental index refresh. |

Notes and risks (answered in phase T0, see `docs/immich-api-notes.md` §10):

- Sorting by `localDateTime` across time zones is wrong. Example: Berlin 15:00 local is 13:00 UTC, and Bangkok 07:00 the next day is 00:00 UTC. Order and gaps always use the instant; only calendar logic uses local time.
- Immich takes `timeZone` from EXIF offset tags, else from the GPS position. **When `timeZone` is `null`, `fileCreatedAt` is the wall-clock time read as UTC**, so the instant is wrong by the real offset. This typically affects camera photos without GPS. Such assets are matched by local time only (§5.5).
- `POST /search/metadata` returns the user's assets **and those of partners who share with "show in timeline"**, including the partners' archived assets. There is no owner filter; `ownerId` on each item tells them apart. Own user id: `GET /users/me` (`user.read`).
- `country` is set for practically every GPS asset on land (nearest place, else country polygon); `null` with GPS means sea or far off-shore.

---

## 3. Architecture: group jobs

### 3.1 Why the existing pipeline doesn't fit

| Today | Trip albums need |
| --- | --- |
| `JobType.select()` yields scored candidates page by page; each asset is judged alone. | A whole-library view in time order: a trip is a cluster, and no single photo decides it. |
| One target album and one exclusion album per job (`job.target_album_*`). | One album per group, created, renamed or adopted over time. |
| Ownership in `job_asset (job_id, asset_id)`. | Ownership and exclusions per group: an asset can be removed from one trip album and stay out of it. |
| Review grid of candidates. | Review list of groups, with the candidate grid per group. |
| Incremental: only assets updated since the last run. | New uploads can extend, split or merge an existing trip, so the neighbourhood must be re-evaluated. |

### 3.2 Overview

A group run has four steps. Only the first talks to Immich's search, and it is resumable page by page like today.

```text
 ┌──────────── 1. Index ────────────┐   ┌──── 2. Group ────┐   ┌──── 3. Reconcile ────┐   ┌──── 4. Sync ─────┐
 │ metadataSource pages → upsert    │   │ job type, pure   │   │ core: match proposed │   │ core: per group  │
 │ asset_index (full or since)      │──►│ function over    │──►│ groups to job_group  │──►│ album create /   │
 │ cursor saved per page            │   │ the whole index  │   │ (new/update/split/   │   │ rename / add /   │
 │                                  │   │ → ProposedGroup[]│   │ merge/vanish/adopt)  │   │ remove (owned)   │
 └──────────────────────────────────┘   └──────────────────┘   └──────────────────────┘   └──────────────────┘
                                                                         │ dry run: stored as run_group
                                                                         ▼ + run_candidate (group_key), no writes
```

- **Index** is generic core code. It is reusable by future group jobs (e.g. "best of a person per year").
- **Group** is the job type: a pure function over index rows, unit-testable without Immich. 100k rows load in under a second and take on the order of 100 MB of heap while grouping.
- **Reconcile** and **Sync** are generic core code. They know nothing about trips.

### 3.3 Job type interface

`JobType` keeps working unchanged for asset jobs. A second kind is added:

```typescript
// core/job-type.ts
export type AnyJobType = JobType | GroupJobType;

export interface GroupJobType<P = unknown> {
  readonly kind: 'groups';
  readonly id: string;                       // 'trip-albums'
  readonly name: string;
  readonly description?: string;
  readonly version: number;                  // bump → re-group + full re-sync (index is kept)
  readonly params: z.ZodType<P>;
  readonly defaultParams: P;
  /** Which index rows the job reads (own / partners / archived / types; T1: the index itself always holds everything). */
  indexFilter(params: P, ownerId: string): IndexReadFilter;
  /** Pure: reads the index, returns all groups of the library. No Immich writes. */
  group(ctx: GroupContext<P>): Promise<ProposedGroup[]>;
}

export interface GroupContext<P> {
  readonly params: P;
  readonly index: AssetIndexReader;          // ordered iteration, time-range queries
  readonly now: Date;
  readonly log: RunLogger;
  readonly signal: AbortSignal;
}

export interface ProposedGroup {
  /** Deterministic from content (e.g. `trip:2026-03-04`); reconcile matches by overlap, not by key. */
  key: string;
  start: Date;                               // trip range (instant)
  end: Date;
  coreStart: Date;                           // core range, used for matching
  coreEnd: Date;
  ongoing: boolean;
  /** Values for the name template and the review UI. */
  summary: { countries: string[]; cities: string[]; localStart: string; localEnd: string; [k: string]: unknown };
  assets: { assetId: string; reasons: string[] }[];  // e.g. ['gps-away'], ['no-gps-camera'], ['transit-departure']
}
```

The registry and the job-types API expose `kind`. The job editor hides the target album fields for group jobs; it keeps the exclusion album.

---

## 4. Asset index

Table `asset_index`, one row per asset in the scope of any group job:

| Column | Type | Notes |
| --- | --- | --- |
| `asset_id` | text PK | |
| `owner_id` | text | Partner assets have another owner. |
| `type` | text | `IMAGE` / `VIDEO` |
| `visibility` | text | `timeline` / `archive` |
| `taken_at` | datetime | Instant (`fileCreatedAt`). Indexed. |
| `local_date_time` | text | Wall-clock time, ISO without zone. |
| `time_zone` | text null | |
| `lat`, `lon` | real null | |
| `city`, `state`, `country` | text null | |
| `has_camera` | boolean | `make` or `model` non-empty. |
| `is_screenshot` | boolean | `description = 'Screenshot'`. |
| `file_name` | text | For the review grid. |
| `immich_updated_at` | datetime | |
| `indexed_at` | datetime | |

- **Scope:** always the widest one (images and videos, timeline and archive, own and partner assets). Jobs narrow it down when reading (own only, archived or not, partners' timeline assets only). So one table serves every group job (T1).
- **Full refresh, every run:** page through `/search/metadata`, upsert each page in one `SqliteService.transaction()` with `indexed_at` = the run's start, save the cursor. At the end, rows not seen in this refresh (`indexed_at < refresh start`) are deleted, so assets deleted or trashed in Immich go away. A resumed refresh reuses the run's start, so it keeps the rows written before the interruption.
- **No incremental refresh:** the full walk of the real library (32k assets) takes ~8 s (API notes §10.6). Should a larger library need it: `updatedAt > since`, plus deleting rows when a sync gets `no_permission` / `not_found`.
- Size: 100k assets ≈ 1.7 s to refresh against a fake Immich and up to ~135 MB of heap when read (one-off measurement, T1).
- The index is a cache. Deleting it only costs one full refresh.

---

## 5. Trip detection

All steps are pure functions in `jobs/trips/` with their own unit tests. Defaults are in §6.

### 5.1 Home inference

Home is computed per **local calendar day** from GPS assets in a window around that day (default ±60 days), weighted by **distinct days**, not by photo count. A two-week holiday with 2,000 photos counts 14 days, not 2,000.

- **Home country** of a day: the country with the most distinct photo days in its window.
- **Home location** of a day: the most frequent ~1 km grid cell (geohash precision 6) in the home country, by distinct days. Optional: a second cell used on ≥ 25 % of home days (e.g. office, parents) also counts as home.
- **Moving abroad:** after about half the window, the new country wins and becomes home. A stay longer than `maxTripDays` is never a trip; it is logged as "home changed?".
- **Sparse data:** days without enough GPS assets in the window inherit the nearest known home. With no GPS at all the job logs a warning and finds nothing.

The home per month is shown on the job page ("Home: Germany, Berlin area since 2019-04") so wrong inference is visible.

### 5.2 Away rule

An asset with GPS is an **away point** when, compared to the home of its local day:

| `awayRule` | Away when |
| --- | --- |
| `other-country` (default) | `country` ≠ home country. Points with GPS but no country (sea, remote areas) are away when > `minDistanceKm` from the home location. |
| `distance` | Distance to the home location > `minDistanceKm` (also catches domestic holidays). |
| `either` | Either of the above. |

### 5.3 Segmenting into trips

Walk all GPS points in instant order and keep the trip that is currently open:

- An away point opens a trip, or extends the open one if the gap since the last away point is ≤ `maxGapHours`.
- A trip is closed by a **home stay**: home points (at the home location or in the home country under the current rule) spanning ≥ `homeStayHours`, or a gap between away points > `maxGapHours`. A single home point in between (e.g. a wrongly geotagged photo) does not split a trip.
- A trip qualifies when it covers ≥ `minTripDays` local calendar days, has ≥ `minAwayAssets` away points, and is ≤ `maxTripDays` long.
- Countries are collected in the order of time spent. Multi-country trips stay one trip.

### 5.4 Transit extension (departure and return)

The core range starts at the first photo abroad. The album should start at departure, e.g. at Berlin airport, which is in the home country and about 20 km from home. Rule:

**The trip starts right after you were last seen at home, and ends right before you are next seen at home.**

Departure, for core start `A`:

1. **Speed check:** take the last GPS point `P` before `A`. If the implied speed `distance(P, A) / (A − P)` is > `transitSpeedKmh`, a flight or train took place, and the search window is `[A − maxTransitHours, A)`. Otherwise (drove, or no photos on the way) the window is only `A`'s **local calendar day**, still at most `maxTransitHours`.
2. Walk back from `A` over the GPS points in the window. The first one **at a home place** (within `homeRadiusKm`) ends the walk, and the trip starts right after it.
3. If the walk reaches the window's start without a home place, the trip starts at the earliest GPS point walked (e.g. the airport photo the evening before).
4. Without any GPS point in the window: the trip starts at the beginning of `A`'s local day, the "same-day" rule. Morning camera photos at the airport before a noon flight are then included.

(T2: implemented in `jobs/trips/transit.ts`; the rule each trip used is shown by the tuning CLI.)

Return: mirrored (first asset at the home location after the core end, bounded by `maxTransitHours`; fallback the end of the local day of arrival).

Assets inside the transit parts get the reason `transit-departure` / `transit-return`. Only GPS assets away from the home location, and camera photos without GPS, are included. Screenshots never are.

Example (Berlin → Bangkok):

```text
Tue 08:10  home (GPS 0.2 km)                    → not in trip (at home location)
Tue 13:40  BER airport (GPS 21 km, Germany)     → transit-departure  ◄ trip starts after 08:10
Tue 14:05  camera photo, no GPS                 → transit-departure
Wed 07:20  Bangkok (Thailand)                   → gps-away  ◄ core start A
 … 16 days …
Fri 22:30  Bangkok airport                      → gps-away  ◄ core end
Sat 06:45  BER arrival (GPS 21 km, Germany)     → transit-return
Sat 09:30  home (GPS 0.1 km)                    → not in trip  ◄ trip ends before this
```

### 5.5 Filling assets without GPS

An asset without GPS joins a trip when:

- `fillWithoutGps = 'camera'` (default): `has_camera` and not `is_screenshot`; or `'all'`; or `'none'`;
- and its time falls inside the trip range: the **instant** when `timeZone` is set; the **local wall-clock time** against the trip's local range when `timeZone` is `null` (its instant is not real, API notes §10.3). (T2: the extra "local time also accepted for assets with a zone" case was dropped. It could put one asset into two neighbouring trips, and the real library has no such camera class.)
- The asset must not lie in more than one trip. It goes to the trip whose range contains its instant first.

Videos follow the same rules (`includeVideos`). Phone videos usually have GPS.

### 5.6 Partner assets

T0 (API notes §10.1–10.2): the search already returns assets of partners who share with "show in timeline", and a partner's **timeline** asset can be added to the user's album (an archived one is refused with `no_permission`). Partner assets are therefore indexed only when `visibility = timeline`. To use a partner's assets, the partner share must have "show in timeline" on. `partnerAssets`:

| Value | Meaning |
| --- | --- |
| `fill` (default) | Partner assets join trips that your own assets established. Their GPS also counts for the transit and fill logic. A trip only your partner took creates no album. |
| `full` | Partner assets can also establish trips. |
| `off` | Ignored. |

With `partnerAssets = off`, partner rows are dropped from the index.

### 5.7 Ongoing trips

A trip is **ongoing** when its last away point is less than `ongoingGraceDays` ago and no home stay has been seen since. An ongoing trip qualifies as soon as it reaches `minTripDays` and `minAwayAssets`. Its album is created and then grows on every run. The return transit is applied once you are seen at home. Closed trips keep updating too: SD-card imports weeks later are indexed and filled into the trip they belong to.

### 5.8 Album name

`nameTemplate`, default `{countries} – {period}`.

The name and the trip key use the **days away** (first to last away photo), not the travel days. An evening flight then doesn't put the previous month into the name, and the key `trip:<first day away>` stays stable when a travel-day boundary moves between runs (T2).

| Placeholder | Example |
| --- | --- |
| `{countries}` | `Thailand & Cambodia` (top 3 by time spent, then `+N`) |
| `{cities}` | `Bangkok, Chiang Mai` (top 3 by distinct days) |
| `{country}` | main country only |
| `{period}` | `Mar 2026`, `Dec 2025 – Jan 2026` |
| `{year}`, `{month}` | `2026`, `Mar` (start) |
| `{start}`, `{end}` | `2026-03-04` (local dates) |
| `{days}` | `17` |

Month names use the `locale` param (default `en`). An empty placeholder is dropped together with its separator. If the name already exists for another album, ` (2)` is appended.

---

## 6. Parameters

T2: the fine-tuning fields (`homeWindowDays` … `ongoingGraceDays`, `adoptMinShare`) are nested under `advanced`; see `backend/src/jobs/trips/trip.params.ts`.

T3: there is no `exclusionAlbum` param. Group jobs use the job's exclusion album field, default `<job name> – excluded`.

```typescript
type TripParams = {
  awayRule: 'other-country' | 'distance' | 'either';  // 'other-country'
  minDistanceKm: number;            // 100
  homeWindowDays: number;           // 60 (± days around each day)
  homeRadiusKm: number;             // 3   "at home location" for transit detection
  minTripDays: number;              // 2   local calendar days (≥ 1 night)
  minAwayAssets: number;            // 5
  maxTripDays: number;              // 60
  maxGapHours: number;              // 72
  homeStayHours: number;            // 24
  maxTransitHours: number;          // 24 (each side)
  transitSpeedKmh: number;          // 200
  fillWithoutGps: 'camera' | 'all' | 'none';  // 'camera'
  includeVideos: boolean;           // true
  includeArchived: boolean;         // false
  partnerAssets: 'fill' | 'full' | 'off';     // 'fill'
  ongoingGraceDays: number;         // 3
  nameTemplate: string;             // '{countries} – {period}'
  locale: string;                   // 'en'
  adoptExisting: 'auto' | 'off';    // 'auto'
  adoptMinShare: number;            // 0.8  share of the album's assets inside the trip range
  minimumYear?: number;             // optional: ignore trips before this year
};
```

The UI form is generated from the Zod schema as usual. Advanced fields (radius, speeds, gaps) are grouped under "Advanced".

---

## 7. Reconcile and sync

### 7.1 Data model additions

| Table | Key columns | Purpose |
| --- | --- | --- |
| `asset_index` | see §4 | Metadata cache for group jobs. |
| `job_group` | `id`, `job_id`, `status`, `start_at`, `end_at`, `core_start_at`, `core_end_at`, `summary` (json), `album_id`, `generated_name`, `name_locked`, `adopted`, `created_by_run_id`, `created_at`, `updated_at` | One trip of a job and its album. |
| `job_group_asset` | `group_id`, `asset_id`, `state`, `run_id`, `changed_at` | Per-trip membership as the job knows it. `state`: `owned` (we added it), `present` (in the album, not added by us: adopted or added by hand), `excluded` (removed by hand → never re-add). PK (`group_id`, `asset_id`). |
| `run_group` | `run_id`, `group_key`, `action`, `job_group_id`, `album_id`, `start_at`, `end_at`, `summary`, `asset_count`, `selected` | **Dry runs only.** The trip list for review. |
| `run_candidate` | + `group_key` (nullable) | Per-trip grid in review. |

`job_group.status`: `active`, `ongoing`, `ignored` (unticked in review, never created by scheduled runs), `orphaned` (no longer detected; album left alone), `merged` (folded into another trip; album left alone), `locked` (frozen by the user; job never touches it).

All writes follow the repo conventions: hand-written `ALTER TABLE` / `CREATE TABLE` migrations, multi-statement writes via `SqliteService.transaction()`, no TypeORM `save()`.

### 7.2 Reconcile (core `GroupReconciler`)

Proposed groups are matched to existing `job_group` rows (not `ignored`/`locked`) by **overlap of the core ranges**:

| Case | Result |
| --- | --- |
| Proposed, no overlap | **New** trip → create album (or adopt, §7.4). |
| 1 ↔ 1 overlap | **Update** existing trip: new range, new summary, membership diff. |
| 1 existing ↔ n proposed (split) | The proposed trip with the largest shared asset set keeps the album; the others are new. |
| n existing ↔ 1 proposed (merge) | The existing trip with most owned assets keeps the album; the others become `merged` (album untouched, flagged in the UI). |
| Existing, no overlap | `orphaned` (album untouched, flagged). It comes back to `active` if detected again. |
| Overlaps an `ignored` trip | Stays ignored; reported in the run log. |
| Overlaps a `locked` trip | Skipped entirely. |

### 7.3 Sync per trip (core `GroupAlbumSync`)

For each trip touched by the run, in this order:

1. **Read the album back**: its members and its name (one metadata search and the album from `GET /albums`).
2. **Detect manual edits**:
   - an `owned` or `present` asset that is no longer a member → `excluded` (removed by hand; stays out);
   - a member not known to the trip → `present` (added by hand; never removed);
   - album name ≠ `generated_name` → `name_locked = true` (renamed by hand; never renamed back).
3. **Add**: `matches − members − excluded(trip) − exclusionAlbum(job)`, in chunks of 500. Added ids → `owned`.
4. **Remove** (sync mode `mirror` only, never for adopted albums): `owned − matches`. Removed ids → dropped from the trip.
5. **Rename**: if the generated name changed and the name is not locked.

Idempotent: a rerun without library changes makes zero write calls. Sync modes keep their meaning (`dry-run`, `additive`, `mirror`), applied per trip. Album description: `Trip detected by Immich Album Jobs (2026-03-03 → 2026-03-21)`.

Runs: the default schedule is nightly. Every run refreshes the whole index (T1: ~8 s for 32k assets), re-groups the whole index and syncs only the trips that changed, so it sees splits and merges too.

### 7.4 Adopting existing albums

When a **new** trip is found, the user's own albums that are not managed by any job are checked:

- `adoptMinShare` (≥ 80 %) of the album's assets lie inside the trip range, and
- the album covers ≥ 30 % of the trip's assets, and
- no other trip claims it.

The best match is adopted: `adopted = true`, `name_locked = true`, existing members become `present`. The job only adds to it, never removes or renames. `GET /albums` already returns each album's `startDate` / `endDate` (local time of the earliest and latest asset). A first filter on those dates needs no extra calls. Member lists are then read only for albums that pass it, cached by `lastModifiedAssetTimestamp`, so this stays cheap with hundreds of albums. In the dry-run review each adoption is shown and can be switched to "create new album".

### 7.5 Guardrails

- Dry runs never change Immich (same rule as today).
- First real run with more than `maxNewAlbumsWithoutReview` (default 30) new trips stops before writing and asks for a dry run and apply. This avoids 200 surprise albums from a mis-tuned config.
- Albums are never deleted. Assets are only removed from albums when `owned` and in mirror mode.

---

## 8. API

Group jobs reuse the run endpoints. Added:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/runs/:id/groups` | Dry run: proposed trips (action, range, summary, counts, cover asset ids). |
| PATCH | `/runs/:id/groups` | Dry run: tick/untick trips, switch adopt ↔ new album. |
| GET | `/runs/:id/candidates?group=…` | Assets of one proposed trip (existing grid). |
| POST | `/runs/:id/apply` | Applies selected trips (existing endpoint, group-aware). |
| GET | `/jobs/:id/groups` | Current trips of a job with status and album link. |
| PATCH | `/jobs/:id/groups/:groupId` | `ignored` / `locked` / back to `active`. |
| GET | `/jobs/:id/insights` | Type-specific insights; trip albums: inferred home per month (for the "Home" panel). T3: generic name instead of `/home`. |

---

## 9. Frontend

### 9.1 Trip review (dry run)

```text
┌ Dry run · Trips · 23 trips found (4 new, 17 unchanged, 1 update, 1 orphaned) ──────────────────────────┐
│ [✓] Thailand & Cambodia – Mar 2026   2026-03-03 → 03-21 · 19 days · 1,214 assets  [NEW]               │
│     ▣ ▣ ▣ ▣  Bangkok, Siem Reap, Chiang Mai · 1,020 GPS · 162 no-GPS camera · 32 transit · 40 partner │
│ [✓] Italy – Aug 2025                  2025-08-09 → 08-17 ·  9 days ·   408 assets  [ADOPT "Toskana 25"]│
│                                                                    (switch to: create new album ▾)   │
│ [ ] Austria – Feb 2025                2025-02-14 → 02-16 ·  3 days ·    37 assets  [NEW]               │
│ [✓] Portugal – Jun 2024               existing album · +12 assets                  [UPDATE]           │
│ ⚠  "Denmark – Jul 2023" no longer detected → album left unchanged                  [ORPHANED]         │
│                                                                       [ Apply 3 selected trips ]      │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Opening a trip shows the existing candidate grid, filtered to that trip, with reasons as chips (`gps-away`, `no-gps-camera`, `transit-departure`, `partner`). Unticking a trip on apply stores it as `ignored`.

### 9.2 Job page

- **Trips tab**: all `job_group` rows with status, date range, album link to Immich, actions ignore / lock / unlock.
- **Home panel**: inferred home country and area per period.
- The job editor hides target album fields for group job types. The params form is generated as usual.

All new interactive elements get `data-testid`s for Playwright.

---

## 10. Performance

| Step | 30k assets | 100k assets |
| --- | --- | --- |
| Full index refresh (every run) | ~30 search calls, ~8 s | ~100 search calls |
| Grouping | in memory, < 1 s | in memory, ~1–2 s, ~100 MB |
| Sync, unchanged trips | 0 writes; 1 member read per touched trip | same |
| First real run, e.g. 80 trips | ~80 album creates + adds | same |

Only trips whose proposed asset set or range changed are "touched" and read back. A daily run usually touches zero or one trip.

---

## 11. Testing

- **Pure detection tests** with synthetic timelines: Berlin → Bangkok with airport photos, multi-country trip, domestic trip under `distance`, weekend trip (`minTripDays`), moving abroad, camera with a wrong time zone, home photos without GPS on departure day, ongoing trip, late SD-card import.
- **Real-data tuning**: a CLI (`npm run trips:detect`) runs detection over an exported index (from the spike tool) and prints the trips, without touching Immich. Real GPS data stays local and is never committed.
- **Reconcile tests**: new / update / split / merge / orphan / ignored / locked.
- **Contract tests** against a throwaway Immich: create trip albums, rename detection, removed-by-hand detection, adoption, idempotent rerun, partner assets (if supported).
- **Scale test**: 100k-asset index, grouping time and memory.
- **Playwright**: trip review list, untick and apply, trips tab.

---

## 12. Open questions

| # | Question | Resolved by |
| --- | --- | --- |
| 1 | Does `/search/metadata` return partner assets, and can our key add them to our album? | **Answered (T0):** yes, for partners sharing with "show in timeline" (incl. their archived assets); timeline assets can be added, archived ones cannot. API notes §10.1–10.2. Confirm on the real instance with `TRIPS_PARTNER_ADD_TEST=1`. |
| 2 | Is `fileCreatedAt` a reliable instant for phone and camera photos; how often is `timeZone` missing? | **Answered (T0) in principle:** reliable when `timeZone` is set (EXIF offset or GPS); wall clock read as UTC when it is `null` (API notes §10.3). On the real library: 85 % of camera images and 5 % of phone images have `null` (API notes §10.6). |
| 3 | GPS coverage of the real library per device (phone vs camera vs messenger). This decides how much the fill matters. | **Answered (T0):** phone 92–97 %, camera images 9 %, no-EXIF images 3 %; 72 % of days have GPS; almost none before 2011 (API notes §10.6). |
| 4 | Is the ~1 km home cell stable enough, or are several home cells needed (work, parents)? | T2 tuning on real data |
| 5 | Should `adoptExisting` also look at shared albums (owned by others)? Default: no. | Review |
| 6 | Should the screenshot job exclude partner assets explicitly? | **Answered (T0):** it currently adds partner screenshots when a partner shares with "show in timeline". Accepted for now (2026-11-03); no change to the screenshot job. |
