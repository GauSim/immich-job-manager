# Immich API notes (phase 0 spike)

| | |
| --- | --- |
| Date | 2026-11-03 |
| Immich server | v3.3.5 (throwaway instance, official compose without ML); rerun 2026-11-03 against the real instance (v3.3.5, with ML) |
| SDK | `@immich/sdk` 3.3.5 |
| Spike tool | [`tools/immich-spike`](../tools/immich-spike/README.md) |

The spike ran against a fresh local Immich v3.3.5 seeded with synthetic fixtures (iOS-style screenshot PNG with `UserComment = "Screenshot"`, the same PNG without the tag, Android and macOS screenshot names, a camera JPEG, and an archived tall PNG). All calls used a **scoped API key** with only the permissions listed below.

**Rerun against the real instance (2026-11-03, via `tools/immich-spike/docker-compose.yaml` on the NAS):** all findings below confirmed. Differences: omitted visibility also returns **hidden** assets (§4.3), `/search/smart` works with ML (§5), and the Range read was verified on a real 8 MB iPhone screenshot (§7). `search.metadata.pageWithFilter` failing with `400` is the expected result of that check.

---

## 1. Answers to SDD §13.3 open items

| Open item | Answer |
| --- | --- |
| Does Immich honour HTTP `Range` on `GET /assets/{id}/original`? | **Yes.** `Range: bytes=0-65535` → `206 Partial Content`, `Accept-Ranges: bytes`, `Content-Range: bytes 0-65535/<size>`, exactly 65,536 bytes. `exifr` parses `UserComment` from that 64 KiB buffer. No stream-and-abort fallback needed for a direct connection (a reverse proxy in between could still strip it; the adapter should treat a `200` as "no range support" and abort the stream after 64 KiB). |
| Exact API key permission names for v3 | See §2. Confirmed via `403 Missing required permission: <name>` responses. |
| Does `withExif` return `make` / `model` / MIME type in search results? | **Yes**, with a caveat: MIME type is **not** in `exifInfo`; it is `originalMimeType` on the asset. `exifInfo` is only present when `withExif: true`. |

## 2. API key permissions

Minimum set for the app (all verified; each endpoint returns `403` without its permission):

| Permission | Needed for |
| --- | --- |
| `server.about` | `GET /server/about` (version check on boot) |
| `asset.read` | `POST /search/metadata`, `POST /search/smart` |
| `asset.view` | `GET /assets/{id}/thumbnail` (thumbnail proxy) |
| `asset.download` | `GET /assets/{id}/original` (iOS tag read) |
| `album.read` | `GET /albums` |
| `album.create` | `POST /albums` |
| `albumAsset.create` | `PUT /albums/{id}/assets` |
| `albumAsset.delete` | `DELETE /albums/{id}/assets` (mirror mode only) |

Not needed: `album.delete`, `asset.delete`, `asset.update`, any admin permission. `GET /server/version` and `/server/ping` need no permission.

## 3. Version check

- `GET /server/about` → `{ version: "v3.3.5", ... }` (string with leading `v`).
- `GET /server/version` → `{ major: 3, minor: 3, patch: 5, prerelease: null }`. **Prefer this for `assertCompatible()`**: structured, and needs no permission. Use `/server/about` only for display.

## 4. `POST /search/metadata`

### 4.1 Pagination – important change vs. SDD

v3.3 has **two** request styles:

| Style | Request | Response | Status |
| --- | --- | --- | --- |
| Legacy | flat fields (`type`, `updatedAfter`, `visibility`, `albumIds`, …) + `page` | `nextPage: "2"` (string), `nextCursor: null` | `page` documented as **deprecated** |
| New | `filter: { … }` DSL + `orderBy` + `cursor` | `nextCursor: "<base64>"`, `nextPage: null` | current |

- `page` combined with `filter` → `400 Deprecated field page cannot be combined with filter`.
- The cursor is opaque base64; today it decodes to `{"offset":N}`, i.e. **offset-based**, not keyset. Assets inserted earlier in the sort order during a run shift the window. That is acceptable for us (album sync is idempotent and incremental runs pick up stragglers), but resume must not assume exactly-once.
- `nextCursor: null` marks the last page.
- `total` and `count` are both the **number of items in this page**, not the library total. There is no cheap total count; progress UI must show "scanned so far", not a percentage (or use `/server/statistics`-style counts later if needed).

**Decision for phase 1/2:** `metadataSource` uses the new `filter` + `orderBy` + `cursor` style; the stored run cursor is Immich's `nextCursor` string. Order by `fileCreatedAt asc` for a stable sequence.

Filter DSL used by us (types from the SDK):

```ts
{
  filter: {
    type: { eq: 'IMAGE' },
    visibility: { in: ['timeline'] },          // + 'archive' when includeArchived
    updatedAt: { gt: since.toISOString() },     // incremental runs
    albumIds: { any: [albumId] },               // album members
  },
  orderBy: { field: 'fileCreatedAt', direction: 'asc' },
  withExif: true,
  size: 1000,
  cursor,                                       // from previous nextCursor
}
```

Other available filters: `originalFileName` (`like`, `startsWith`, `in`, …), `make`/`model`/`lensModel`, `takenAt`, `createdAt`, `fileSizeInBytes`, `rating`, `tagIds`, `personIds`, `hasAlbums`, and `or: [...]` branches. Sort fields: `fileCreatedAt`, `localDateTime`, `fileSizeInBytes`, `rating`.

### 4.2 Fields on each item

All present on every item (with `withExif: true`):

| Field | Notes |
| --- | --- |
| `id`, `checksum` | checksum is base64 SHA-1, e.g. `PbBUmPzDDm22mKEeI1WplqoeS6c=` |
| `originalFileName` | e.g. `IMG_0001.PNG` |
| `originalMimeType` | e.g. `image/png`; optional in the type, present in practice |
| `width`, `height` | on the asset; also `exifInfo.exifImageWidth/Height` |
| `updatedAt`, `fileCreatedAt`, `localDateTime` | ISO strings |
| `visibility` | `timeline`, `archive`, `hidden`, `locked` |
| `exifInfo.make`, `.model`, `.lensModel` | `null` when absent (not `undefined`) |
| `exifInfo.exposureTime` | **string**, e.g. `"1/250"` |
| `exifInfo.fNumber` | number, e.g. `2.8` |
| `exifInfo.description` | `""` when absent; Immich does **not** expose `UserComment` (confirmed: iOS-tagged PNG has empty description) |

"No camera EXIF" check must treat `null` (and `""`) as empty.

### 4.3 Visibility

- Omitting `visibility` (legacy) or `filter.visibility` (new) returns timeline + archive **and hidden** assets. On the real instance the hidden ones were Live Photo motion parts (`.MOV`, 103 of 1,000 in the legacy result). Differs from SDD §5.3, which assumed timeline + archive only.
- `visibility: 'timeline'` / `filter.visibility: { in: ['timeline'] }` excludes archived assets.
- The adapter always sets visibility explicitly from `includeArchived`.

### 4.4 `updatedAfter`

Both `updatedAfter` (legacy) and `filter.updatedAt.gt` work as expected (future → 0, past → all).

## 5. `POST /search/smart`

Works on the real instance (ML running): 5 results for a text query, paginated like legacy search (`nextPage: "2"`). Needs the machine-learning container. Without it the server returns `500 Failed to search smart` (after the permission check, so `asset.read` is sufficient). The adapter must map this to a clear "Immich ML unavailable" error and the job should skip the CLIP signal rather than fail. 

## 6. Albums

- `GET /albums` / `POST /albums` responses have **no `assets` field** (v3), only `assetCount`. Keys: `albumName, albumThumbnailAssetId, albumUsers, assetCount, createdAt, description, hasSharedLink, id, isActivityEnabled, order, shared, updatedAt`.
- Members: `POST /search/metadata` with `albumIds` (or `filter.albumIds.any`) works.
- `PUT /albums/{id}/assets` (SDK `addAssetsToAlbum`; SDK 3.3.5 still uses `PUT`) returns one entry per id:

  ```json
  [
    { "id": "…", "success": true },
    { "id": "…", "success": false, "error": "duplicate" },
    { "id": "…", "success": false, "error": "no_permission" }
  ]
  ```

  `duplicate` = already a member (treat as success for ownership only if we added it earlier). Unknown or foreign ids → `no_permission`.
- `DELETE /albums/{id}/assets` (SDK `removeAssetFromAlbum`) returns the same shape; ids not in the album → `error: "not_found"`.
- Both return `200` even when some ids fail; per-id results must be checked.

## 7. Originals and thumbnails

- `GET /assets/{id}/original` with `Range` → `206` (see §1). Without `Range` → `200` with the full file.
- `GET /assets/{id}/thumbnail` needs `asset.view`.
- `exifr.parse(buffer, { pick: ['UserComment'] })` returns `userComment` as **raw bytes**: 8-byte charset prefix (`ASCII\0\0\0`, `UNICODE\0`, …) + payload. Decode before comparing to `"Screenshot"` (see `decodeUserComment` in `tools/immich-spike/src/spike.ts`).
- In the test PNG the `eXIf` chunk sits right after `IHDR`. **Verified on a real iPhone screenshot** (8.1 MB PNG): `206`, 65,536 bytes, `UserComment` decodes to `"Screenshot"` from the first 64 KiB.

## 8. Errors

- Validation error: `400 { message: "Validation failed", errors: [{ code, path: ["size"], message, … }] }`.
- Every response carries `x-correlation-id` (short id, e.g. `iqq1yfjn`); log it on failures.
- Permission error: `403 { message: "Missing required permission: <name>" }`.

## 9. Impact on the plan / SDD

| Area | Change |
| --- | --- |
| Phase 1 `ImmichClient.searchMetadataPage` | Use `filter` + `orderBy` + `cursor`, not `page`. Return `{ items, nextCursor }`. |
| Phase 1 `assertCompatible()` | Use `GET /server/version` (`major === 3`). |
| Phase 2 `metadataSource` cursor | Store Immich's `nextCursor` string; resume passes it back. Offset-based, so resume is "at least once". |
| Phase 2/4 progress | No library total from search; show scanned count (optionally a separate total from a statistics endpoint later). |
| Phase 3 `exifScorer` | MIME from `originalMimeType`; treat `null`/`""` EXIF fields as empty. |
| Phase 5 `AlbumSyncService` | Check per-id `success`/`error`; `duplicate` and `not_found` are benign. |
| Phase 6 `fileTagScorer` | Range read is supported; decode `UserComment` bytes; fall back to stream-and-abort if a `200` comes back. |
| Phase 6 CLIP | Handle `500` from `/search/smart` as "ML unavailable" → skip signal. |
| Phase 1/2 visibility | Always send `filter.visibility` explicitly: omitting it also returns hidden assets (Live Photo motion parts). |
| README (phase 8) | Document the permission list in §2. |
