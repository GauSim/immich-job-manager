import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** App version from package.json (next to dist/ in the image, next to src/ in development). */
export const APP_VERSION: string = (() => {
  for (const candidate of [
    join(import.meta.dirname, '../package.json'),
    join(process.cwd(), 'package.json'),
  ]) {
    try {
      return (
        JSON.parse(readFileSync(candidate, 'utf8')) as { version: string }
      ).version;
    } catch {
      // try the next location
    }
  }
  return 'unknown';
})();
