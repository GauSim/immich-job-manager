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

## Run with Docker Compose (e.g. on a NAS without a console)

`docker-compose.yml` runs the spike once in a `node:22-alpine` container (no image build needed):

1. `cp spike.env.example spike.env` and fill in `IMMICH_URL`, `IMMICH_API_KEY` (and optionally `SPIKE_ASSET_ID`). `spike.env` is git-ignored.
   If Immich runs on the same NAS with port 2283 published, the default `http://host.docker.internal:2283/api` works; otherwise use `http://<nas-ip>:2283/api`.
2. Copy this folder to the NAS (`node_modules/` can be left out; it is reinstalled inside the container).
3. In the NAS Docker app (UGREEN: Docker → Project → Create), point the project at the folder and use the included `docker-compose.yml`. Start it.

The container installs dependencies, runs the spike and exits (`restart: "no"`). Read the result in the container log; the report is written to `out/spike-report.json` in the folder. Start the project again to rerun.

## Throwaway local instance (optional)

Only for a fresh, disposable Immich (it signs up an admin and uploads test files):

```bash
npm run fixtures                                  # needs python3 + Pillow
IMMICH_URL=http://localhost:2283/api npm run seed # prints a scoped API key
IMMICH_URL=http://localhost:2283/api IMMICH_API_KEY=$(cat out/api-key) npm run spike
```

Start the instance with Immich's official `docker-compose.yml` and `example.env` from the latest release (the machine-learning service is optional; without it `/search/smart` returns 500).
