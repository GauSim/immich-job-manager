# Immich API spike

Phase 0 tool that checks the Immich v3 API shapes Immich Album Jobs relies on. Findings live in [`docs/immich-api-notes.md`](../../docs/immich-api-notes.md).

## Run against your Immich instance

Create an API key in Immich (Account settings → API keys) with exactly these permissions:
`server.about`, `asset.read`, `asset.view`, `asset.download`, `album.read`, `album.create`, `albumAsset.create`, `albumAsset.delete`.

```bash
npm ci
IMMICH_URL=http://<host>:2283/api IMMICH_API_KEY=<key> npm run spike
```

Optional: `SPIKE_ASSET_ID=<id of a real iPhone screenshot>` to test the partial read and `UserComment` parsing on a real file.

Side effects: creates the album `immich-album-jobs-spike` (if missing), adds up to 3 assets and removes them again. Delete the empty album by hand afterwards. The report is written to `out/spike-report.json`.

## Throwaway local instance (optional)

Only for a fresh, disposable Immich (it signs up an admin and uploads test files):

```bash
npm run fixtures                                  # needs python3 + Pillow
IMMICH_URL=http://localhost:2283/api npm run seed # prints a scoped API key
IMMICH_URL=http://localhost:2283/api IMMICH_API_KEY=$(cat out/api-key) npm run spike
```

Start the instance with Immich's official `docker-compose.yml` and `example.env` from the latest release (the machine-learning service is optional; without it `/search/smart` returns 500).
