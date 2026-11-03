import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_APP_PORT ?? 4310);

/**
 * UI smoke tests against the real backend + production UI build and a fake Immich.
 * Run `npm run e2e:prepare` (builds UI and backend) before `npm run e2e`.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/stack.mjs',
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
  },
});
