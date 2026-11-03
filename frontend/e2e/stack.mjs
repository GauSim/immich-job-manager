// Starts a fake Immich and the real backend (serving the production UI build)
// for the Playwright smoke tests. Prerequisite: `npm run e2e:prepare`.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 4310);
const IMMICH_PORT = Number(process.env.E2E_IMMICH_PORT ?? 4311);
const COPIES = Number(process.env.E2E_LIBRARY_COPIES ?? 30);

const uuid = (s) => {
  const h = createHash('sha1').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// Anonymised real-library metadata (999 images), repeated to simulate a large library.
const sample = JSON.parse(
  readFileSync(resolve(here, '../../backend/test/fixtures/real-library-sample.json'), 'utf8'),
);
const library = [];
for (let c = 0; c < COPIES; c++) {
  for (const a of sample) {
    library.push({
      ...a,
      id: uuid(`${c}-${a.id}`),
      originalFileName: c ? a.originalFileName.replace(/(\.\w+)$/, `-${c}$1`) : a.originalFileName,
    });
  }
}

// Raster thumbnails like Immich's (WebP/JPEG decode off the main thread; SVG would not).
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
/** 120×240 RGB PNG: a coloured "phone screen" with a status bar and some noise. */
function thumbnailPng(seed) {
  const w = 120;
  const h = 240;
  const [r, g, b] = [seed & 0xff, (seed >> 8) & 0xff, (seed >> 16) & 0xff];
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const bar = y > 12 && y < 26;
      const noise = (x * 31 + y * 17 + seed) % 23;
      row[1 + x * 3] = bar ? 230 : (r + noise) & 0xff;
      row[2 + x * 3] = bar ? 230 : (g + noise) & 0xff;
      row[3 + x * 3] = bar ? 230 : (b + noise) & 0xff;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'x-correlation-id': 'e2e' });
  res.end(JSON.stringify(body));
};

const immich = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/server/version')
      return json(res, 200, { major: 3, minor: 3, patch: 5 });
    if (req.method === 'POST' && url.pathname === '/api/search/metadata') {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const offset = body.cursor
        ? JSON.parse(Buffer.from(body.cursor, 'base64').toString()).offset
        : 0;
      const size = body.size ?? 1000;
      const items = library.slice(offset, offset + size);
      const next =
        offset + size < library.length
          ? Buffer.from(JSON.stringify({ offset: offset + size })).toString('base64')
          : null;
      return json(res, 200, {
        albums: { total: 0, count: 0, items: [], facets: [], nextPage: null },
        assets: {
          total: items.length,
          count: items.length,
          items,
          facets: [],
          nextPage: null,
          nextCursor: next,
        },
      });
    }
    const thumb = /^\/api\/assets\/([0-9a-f-]{36})\/thumbnail$/.exec(url.pathname);
    if (req.method === 'GET' && thumb) {
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'private, max-age=86400',
      });
      return res.end(thumbnailPng(parseInt(thumb[1].slice(0, 6), 16)));
    }
    json(res, 404, { message: 'Not found' });
  });
});

const dataDir = mkdtempSync(join(tmpdir(), 'iaj-ui-e2e-'));
let backend;
const shutdown = () => {
  backend?.kill('SIGTERM');
  immich.close();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

immich.listen(IMMICH_PORT, '127.0.0.1', () => {
  console.log(`fake Immich on :${IMMICH_PORT} with ${library.length} assets`);
  backend = spawn(process.execPath, ['dist/main.js'], {
    cwd: resolve(here, '../../backend'),
    stdio: 'inherit',
    env: {
      ...process.env,
      IMMICH_URL: `http://127.0.0.1:${IMMICH_PORT}/api`,
      IMMICH_API_KEY: 'e2e',
      APP_PASSWORD: 'e2e',
      DATA_DIR: dataDir,
      PUBLIC_DIR: resolve(here, '../dist/frontend/browser'),
      PORT: String(APP_PORT),
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
    },
  });
  backend.on('exit', (code) => {
    console.log(`backend exited (${code})`);
    shutdown();
  });
});
