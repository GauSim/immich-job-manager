# Trip Albums – Implementation Plan

| | |
| --- | --- |
| Version | 0.1 |
| Date | 2026-11-03 |
| Owner | Simon |
| Based on | `trip-albums-SDD.md` v0.1, on top of Immich Album Jobs v1.0 |

---

## 1. Summary

Seven phases, prefixed **T** so they don't clash with the v1 plan. Detection (T2) is pure code and is tuned on real data **before** any album is written. Trip albums are **usable after T5** (manual dry run + apply). They are **fully automated after T6** (scheduled, incremental, partner assets).

| Phase | Goal | Depends on | Size | Milestone |
| --- | --- | --- | --- | --- |
| T0 | API spike and real-data check | v1.0 | S | Open questions 1–3, 6 answered |
| T1 | Asset index (generic) | T0 | M | Library mirrored locally |
| T2 | Trip detection engine (pure) + tuning CLI | T0 (T1 for real data) | L | **TM1: trips correct on the real library (CLI)** |
| T3 | Group job framework: interface, reconcile, runner, dry run | T1, T2 | L | Dry run stores proposed trips via API |
| T4 | Group album sync: create, update, edits, adoption | T3 | L | **TM2: trip albums in Immich** |
| T5 | Frontend: trip review, trips tab, home panel | T3 (T4 for apply) | M | **TM3: review and apply in the UI** |
| T6 | Scheduling, ongoing trips, partner assets, scale, docs | T4, T5 | M | **TM4: fully automated, release** |

Size: S ≈ 1–2 evenings, M ≈ 3–5, L ≈ 6–10 (rough, solo developer).

```text
T0 ─► T1 ─┬─► T3 ─► T4 ─┬─► T6
T0 ─► T2 ─┘      └► T5 ─┘
```

T1 and T2 can run in parallel: T2 starts on synthetic timelines and switches to real data once T1 (or the T0 export) exists. T5 can start once T3's API exists; its apply button needs T4.

---

## 2. Phases

### Phase T0 – API spike and real-data check

**Goal:** answer the SDD open questions that can change the design before writing it.

**Status:** in progress (2026-11-03) – API questions answered from the Immich v3.3.5 server source; pending: `npm run trips` on the real instance

- Note: a throwaway Immich could not be started in the development sandbox: the network policy blocks `pkg-containers.githubusercontent.com`, so the GHCR images can't be pulled. API behaviour was therefore read from the Immich **v3.3.5 server source** (tag `v3.3.5`) instead of observed. The `trips` script was smoke-tested against a local fake Immich. Real-library numbers come from running it on the NAS.

Tasks:

- [x] Extend `tools/immich-spike` with a `trips` mode:
  - Note: `npm run trips` (`src/trips.ts`), read-only unless `TRIPS_PARTNER_ADD_TEST=1`. Compose: `SPIKE_SCRIPT=trips` in `spike.env`.
  - [x] Does `POST /search/metadata` return partner assets (`ownerId` ≠ key owner) with and without a partner sharing "in timeline"? Can `ownerId` be filtered?
    - Note: yes, for partners sharing **with "show in timeline"** only, including their archived assets. No owner filter in the v3 DSL; tell them apart by `ownerId` (API notes §10.1). The script reports the counts on the real library.
  - [x] `PUT /albums/{id}/assets` with a partner's asset id: `success` or `no_permission`?
    - Note: from source, timeline (and hidden) partner assets → `success`; archived → `no_permission` (API notes §10.2). The script's `TRIPS_PARTNER_ADD_TEST=1` confirms it on the real instance.
  - [x] Compare `fileCreatedAt`, `localDateTime`, `exifInfo.dateTimeOriginal` and `timeZone` for phone photos, camera photos (with and without time zone) and videos, on a trip abroad.
    - Note: from source: `timeZone` comes from EXIF offsets, else GPS (`geoTz`); when `null`, `fileCreatedAt` = wall clock read as UTC (API notes §10.3). The script reports the `timeZone`-null share and the local − instant offsets per device class. SDD §5.5 refined (local-time match when `timeZone` is null).
  - [x] Does `GET /albums` expose `updatedAt` / `startDate` / `endDate` usable for the adoption pre-filter?
    - Note: yes for non-empty albums, plus `lastModifiedAssetTimestamp` (API notes §10.5). SDD §7.4 updated. Renaming needs `album.update`.
- [ ] Export an **anonymised stats report** over the real library (committed) and a **raw index export** (local only, gitignored): GPS share per device class (phone / camera / no camera / screenshot), `country` coverage when GPS is set, `timeZone` coverage.
  - Note: the tool is done (`out/trips-stats.json` and `out/trips-index.json`, format version 1 for the T2 CLI). Pending: run on the NAS and copy the stats to `docs/spike-out/trips-stats.json`.
- [x] If partner assets are returned today, open a follow-up for the screenshot job (SDD open question 6).
  - Note: confirmed from source: `metadataSource` adds partner screenshots when a partner shares with "show in timeline". Decided (2026-11-03) to accept this for now; no follow-up issue.
- [x] Record findings in `docs/immich-api-notes.md` (new section "Trips") and update the SDD where they differ.
  - Note: API notes §10. SDD §1.3, §2, §5.5, §5.6, §7.4 and §12 updated. New key permissions for the job: `user.read`, `album.update` (API notes §10.7).

- [ ] **Deliverables:** spike mode, notes, anonymised stats, local raw export.
  - Note: spike mode and notes ✓; stats and export pending the real run.

- [ ] **Done when:** SDD open questions 1, 2, 3 and 6 have answers in the notes; `partnerAssets` is either confirmed or removed from the design.
  - Note: 1, 2 (in principle) and 6 answered; `partnerAssets` confirmed (timeline assets only). 3 and the numbers for 2 are pending the real run.

---

### Phase T1 – Asset index

**Goal:** a local, refreshable copy of the metadata that grouping needs (SDD §4).

**Status:** not started

Tasks:

- [ ] Entity `AssetIndexEntity` + hand-written migration `AssetIndex` (table, index on `taken_at`, on `country`); register in `migrations/index.ts`.
- [ ] `ImmichClient`: make sure `searchMetadataPage` returns everything the index needs (GPS, place, `ownerId`, `fileCreatedAt`, `localDateTime`, `timeZone`); add an `ownerId` filter if T0 shows it is needed.
- [ ] `AssetIndexService` (`src/index/`):
  - [ ] `refresh(scope, { since?, resumeFrom?, signal })` yields pages with cursors; each page is upserted in one `SqliteService.transaction()`.
  - [ ] Full refresh deletes rows not seen in this refresh.
  - [ ] `forget(assetIds)` for ids Immich refused (deleted assets).
- [ ] `AssetIndexReader`: ordered iteration by `taken_at` (all rows in memory as compact objects), `between(start, end)`.
- [ ] Mapping helpers: `has_camera` (null/`""` = empty, API notes §4.2), `is_screenshot`.

- [ ] **Tests:** mapping, upsert idempotency, full-refresh deletion, incremental refresh, resume from cursor (fake Immich server).

- [ ] **Done when:** a full refresh of the real library completes and resumes after an interrupt; an incremental refresh only fetches changed assets.

---

### Phase T2 – Trip detection engine and tuning CLI

**Goal:** correct trips on the real library, before any album is written (SDD §5).

**Status:** not started

Tasks:

- [ ] `jobs/trips/` pure modules, each with unit tests:
  - [ ] `geo.ts`: haversine, geohash cells.
  - [ ] `home.ts`: home country and home cells per local day, weighted by distinct days, rolling window, fallback for sparse data (SDD §5.1).
  - [ ] `away.ts`: `other-country` / `distance` / `either` (§5.2).
  - [ ] `segment.ts`: open/extend/close trips; home stay; qualification (§5.3).
  - [ ] `transit.ts`: last-seen-at-home rule, speed check, same-day fallback, `maxTransitHours` (§5.4).
  - [ ] `fill.ts`: no-GPS fill by instant or local time; camera/screenshot rules; one trip per asset (§5.5).
  - [ ] `naming.ts`: template, placeholders, `{period}` formatting, locale, empty placeholder handling (§5.8).
  - [ ] `detect.ts`: puts it together → `ProposedGroup[]` with reasons and summary.
- [ ] `trip.params.ts`: Zod schema with defaults (SDD §6), advanced fields grouped.
- [ ] Synthetic timeline fixtures: Berlin → Bangkok with airport, multi-country, domestic (`distance`), weekend, moving abroad, camera with wrong time zone, home photos without GPS on departure day, ongoing trip, late SD-card import, wrongly geotagged single photo mid-trip.
- [ ] CLI `npm run trips:detect -- <index-export.json> [params.json]`: prints trips (dates, countries, counts per reason, home per period) without touching Immich.
- [ ] Tune defaults on the real export (T0/T1); record changed defaults as notes here and in SDD §6.

- [ ] **Tests:** all fixtures above; property test that every asset lands in at most one trip; detection is deterministic.

- [ ] **Done when:** on the real library the CLI lists your known trips with correct start (departure) and end (arrival), and no obvious false trips. Remaining mistakes are documented.

---

### Phase T3 – Group job framework

**Goal:** the core can run a group job end to end as a dry run (SDD §3, §7.1, §7.2).

**Status:** not started

Tasks:

- [ ] `core/job-type.ts`: `GroupJobType`, `GroupContext`, `ProposedGroup`, `AnyJobType`; `JobTypeRegistry` and `/api/job-types` expose `kind`.
- [ ] Entities + hand-written migration `JobGroups`: `job_group`, `job_group_asset`, `run_group`, `run_candidate.group_key`.
- [ ] `GroupReconciler` (pure): new / update / split / merge / orphan / ignored / locked (SDD §7.2).
- [ ] `RunExecutor`: dispatch by `kind`; group run = index (resumable) → group → reconcile → dry run stores `run_group` + `run_candidate` (with `group_key`). Totals: indexed, trips found / new / updated / orphaned, assets matched.
- [ ] `RunLauncher`: full vs. incremental for group jobs (index `since`; regrouping is always full); weekly full refresh (`fullRefreshEveryDays`).
- [ ] `TripAlbumsJob` (`@AlbumJobType()`, listed in `JOB_TYPES`) wiring T2 into `group()`.
- [ ] API: `GET/PATCH /runs/:id/groups`, `GET /runs/:id/candidates?group=`, `GET /jobs/:id/groups`, `PATCH /jobs/:id/groups/:groupId`, `GET /jobs/:id/home`.
- [ ] Job create/update: target album optional for group job types.

- [ ] **Tests:** reconciler cases; executor dry run with a fake job type and fake Immich (no writes); resume during indexing; API e2e.

- [ ] **Done when:** a dry run of the trip job over the real library stores the trip list, readable through the API, and makes zero Immich writes.

---

### Phase T4 – Group album sync

**Goal:** trips become Immich albums and stay correct across reruns and manual edits (SDD §7.3–7.5).

**Status:** not started

Tasks:

- [ ] `GroupAlbumSync` in `src/sync/` (all album writes stay in the sync module):
  - [ ] Create album with description; unique name (` (2)`).
  - [ ] Read back members and name; detect removed-by-hand (→ `excluded`), added-by-hand (→ `present`), renamed (→ `name_locked`).
  - [ ] Add `matches − members − excluded − job exclusion album`; record `owned`.
  - [ ] Mirror: remove `owned − matches` (never for adopted albums).
  - [ ] Rename when the generated name changed and is not locked.
  - [ ] Forget index rows on `no_permission` / `not_found`.
- [ ] `ImmichClient`: `renameAlbum`, album metadata read (`updatedAt`, name) if not present.
- [ ] Adoption (§7.4): candidate albums not managed by any job, member times from the index, thresholds, cache by album `updatedAt`.
- [ ] Apply of a dry run: selected trips only; unticked trips → `ignored`; adopt ↔ new switch honoured.
- [ ] Guardrail `maxNewAlbumsWithoutReview` on the first real run.
- [ ] Merged / orphaned trips: no album writes, flagged.

- [ ] **Tests:** unit tests for edit detection and diffs; contract tests against a throwaway Immich: create, idempotent rerun (0 writes), rename kept, removed asset stays out, added asset kept, adoption, mirror removal of owned only, dry run never writes.

- [ ] **Done when:** applying a dry run on the real library creates the expected albums, a rerun makes zero writes, and manual edits in Immich survive the next run.

---

### Phase T5 – Frontend

**Goal:** review and manage trips in the UI (SDD §9).

**Status:** not started

Tasks:

- [ ] Run detail for group jobs: trip review list (cards with dates, countries, counts per reason, 4 cover thumbnails, action badge NEW / UPDATE / ADOPT / ORPHANED / MERGED), tick/untick, adopt ↔ new switch, apply.
- [ ] Trip detail: existing candidate grid filtered by `group`, reason chips.
- [ ] Job page: Trips tab (status, range, Immich album link, ignore / lock / unlock) and Home panel.
- [ ] Job editor: hide target album for `kind: 'groups'`; params form generated as usual (advanced group collapsed).
- [ ] `data-testid`s; lazy routes; keep Formly on editor routes only.

- [ ] **Tests:** component tests; Playwright: dry run → review list → untick → apply → trips tab.

- [ ] **Done when:** a trip job can be created, previewed, tuned and applied entirely from the UI.

---

### Phase T6 – Automation, partner assets, scale, docs

**Goal:** configure once, runs by itself (SDD §5.6, §5.7, §7.3).

**Status:** not started

Tasks:

- [ ] Scheduled runs for group jobs via `JobScheduler`: nightly incremental, weekly full index refresh.
- [ ] Ongoing trips: created when qualified, grow per run, return transit applied once home (fixtures + contract test with time travel).
- [ ] Late imports: closed trips pick up newly indexed assets.
- [ ] Partner assets per T0 result (`fill` / `full` / `off`), or remove the param with a note.
- [ ] Housekeeping: `run_group` retention like `run_candidate`; index rows of out-of-scope assets.
- [ ] Scale test: 100k-asset index, grouping time and memory under `npm run test:scale`.
- [ ] Docs: README section "Trip albums" (what it does, params, API key permissions incl. album update for rename), `.env.example` if new config, CLAUDE.md layout table.
- [ ] Main plan backlog: link this plan.

- [ ] **Deliverables:** release with the trip job.

- [ ] **Done when:** a scheduled trip job runs a week on the real library with no interaction: it creates an album for a new trip, extends it during the trip, and keeps manual edits.

---

## 3. Definition of done (every phase)

Same as the v1 plan §3: lint, format check, typecheck, tests and build green for every touched package. Migrations are hand-written and reviewed. Tasks are checked off in this file in the same commit. Deviations are recorded as indented notes.

## 4. Risks and mitigations

| Risk | Impact | Mitigation | Phase |
| --- | --- | --- | --- |
| Low GPS coverage (cameras, messenger images) | Short or missing trips | No-GPS fill; measure coverage first | T0, T2 |
| Wrong instant from cameras without a time zone | Fill misses edge photos | Match on instant **or** local time | T2 |
| Home inference wrong for sparse years / frequent travellers | False or missing trips | Distinct-day weighting, home panel in UI, tuning CLI | T2, T5 |
| Many albums from a mis-tuned first run | Clutter in Immich | Dry-run review, `maxNewAlbumsWithoutReview` guardrail | T4 |
| Trip boundaries move between runs | Albums lose or gain assets unexpectedly | Overlap reconcile; additive default; manual edits always win | T3, T4 |
| Partner assets not addable | Feature gap | T0 decides; param removed if unsupported | T0, T6 |
| Real GPS data in the repo | Privacy | Raw exports gitignored; only anonymised stats committed | T0, T2 |
