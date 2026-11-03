/**
 * Seeds a THROWAWAY Immich v3 instance for the API spike:
 *   1. signs up the admin user (only works on a fresh instance),
 *   2. creates a scoped API key with the permissions the app should need,
 *   3. uploads the generated fixtures (npm run fixtures),
 *   4. archives wallpaper.png (to test search visibility defaults).
 *
 * Never run this against your real library.
 *
 *   IMMICH_URL=http://localhost:2283/api npm run seed
 *
 * Prints the scoped API key on the last line (also written to out/api-key).
 */
import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  defaults,
  signUpAdmin,
  login,
  createApiKey,
  uploadAsset,
  updateAssets,
  AssetVisibility,
  Permission,
} from '@immich/sdk';

const baseUrl = process.env.IMMICH_URL ?? 'http://localhost:2283/api';
const email = process.env.SEED_EMAIL ?? 'admin@example.com';
const password = process.env.SEED_PASSWORD ?? 'spike-password';
const fixturesDir = process.env.FIXTURES_DIR ?? 'fixtures';

/** Permissions we expect Immich Album Jobs to need (see docs/immich-api-notes.md). */
export const REQUIRED_PERMISSIONS: Permission[] = [
  Permission.ServerAbout, // GET /server/about (version check)
  Permission.AssetRead, // POST /search/metadata, /search/smart
  Permission.AssetView, // GET /assets/{id}/thumbnail
  Permission.AssetDownload, // GET /assets/{id}/original (iOS tag)
  Permission.AlbumRead, // GET /albums
  Permission.AlbumCreate, // POST /albums
  Permission.AlbumAssetCreate, // PUT /albums/{id}/assets
  Permission.AlbumAssetDelete, // DELETE /albums/{id}/assets (mirror mode)
];

async function main() {
  defaults.baseUrl = baseUrl;

  try {
    await signUpAdmin({ signUpDto: { email, password, name: 'Spike Admin' } });
    console.log(`signed up admin ${email}`);
  } catch (e) {
    console.log(`admin sign-up skipped (${(e as Error).message})`);
  }

  const { accessToken } = await login({ loginCredentialDto: { email, password } });
  const auth = { headers: { Authorization: `Bearer ${accessToken}` } };

  const { secret } = await createApiKey(
    { apiKeyCreateDto: { name: 'immich-album-jobs-spike', permissions: REQUIRED_PERMISSIONS } },
    auth,
  );

  const files = (await readdir(fixturesDir)).sort();
  for (const name of files) {
    const path = join(fixturesDir, name);
    const { mtime } = await stat(path);
    const data = await readFile(path);
    const res = await uploadAsset(
      {
        assetMediaCreateDto: {
          assetData: new File([data], name),
          filename: name,
          fileCreatedAt: mtime.toISOString(),
          fileModifiedAt: mtime.toISOString(),
        },
      },
      auth,
    );
    console.log(`uploaded ${name} -> ${res.id} (${res.status})`);
    if (name === 'wallpaper.png') {
      await updateAssets(
        { assetBulkUpdateDto: { ids: [res.id], visibility: AssetVisibility.Archive } },
        auth,
      );
      console.log(`archived ${name}`);
    }
  }

  await mkdir('out', { recursive: true });
  await writeFile('out/api-key', secret);

  // Separate key that may only upload: lets contract tests add new assets
  // (incremental runs) without giving the app's key upload rights.
  const upload = await createApiKey(
    { apiKeyCreateDto: { name: 'immich-album-jobs-contract-upload', permissions: [Permission.AssetUpload] } },
    auth,
  );
  await writeFile('out/upload-key', upload.secret);
  console.log(secret);
}

await main();
