import { expect, test } from '@playwright/test';

/** 30 copies of the anonymised real-library sample: 29,970 assets → 2,910 candidates. */
const EXPECTED_CANDIDATES = 2910;

test('create a screenshot job, dry-run it and review thousands of candidates', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // Dashboard
  await page.goto('/');
  await expect(page.getByTestId('immich-status')).toContainText('Immich connected');
  await expect(page.getByText('No jobs yet')).toBeVisible();

  // Create job (generated params form is shown)
  await page.getByRole('link', { name: 'New job' }).click();
  await expect(page.getByTestId('params-form')).toContainText('Threshold');
  await page.getByTestId('job-name').fill('Screenshots');
  await page.getByTestId('target-album').fill('Screenshots');
  await page.getByTestId('save-job').click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);

  // Dry run → run detail with live status, then review grid
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 30_000 });
  await expect(page.getByTestId('scanned')).toHaveText('29970');
  await expect(page.getByTestId('matched')).toHaveText(String(EXPECTED_CANDIDATES));
  await expect(page.getByTestId('chip-all')).toContainText(`All (${EXPECTED_CANDIDATES})`);
  await expect(page.getByTestId('candidate').first()).toBeVisible();
  await expect(page.locator('img.thumb').first()).toHaveJSProperty('complete', true);

  // Virtual scroll: only a few rows in the DOM, smooth scrolling to the very end.
  const viewport = page.locator('cdk-virtual-scroll-viewport');
  const rendered = await page.getByTestId('candidate').count();
  expect(rendered).toBeLessThan(200);
  // Scroll through the whole list at a fast trackpad pace (150 px/frame ≈ 9,000 px/s).
  const frames = await viewport.evaluate(
    (el) =>
      new Promise<{ avg: number; p95: number; frames: number }>((resolve) => {
        const times: number[] = [];
        let last = performance.now();
        const step = () => {
          const now = performance.now();
          times.push(now - last);
          last = now;
          el.scrollTop += 150;
          if (el.scrollTop + el.clientHeight < el.scrollHeight - 1) requestAnimationFrame(step);
          else {
            times.shift();
            const sorted = [...times].sort((a, b) => a - b);
            resolve({
              avg: times.reduce((a, b) => a + b, 0) / times.length,
              p95: sorted[Math.floor(sorted.length * 0.95)],
              frames: times.length,
            });
          }
        };
        requestAnimationFrame(step);
      }),
  );
  console.log(
    `scroll ${frames.frames} frames: avg ${frames.avg.toFixed(1)} ms, p95 ${frames.p95.toFixed(1)} ms`,
  );
  expect(frames.avg).toBeLessThan(33); // ≥ 30 fps on average, even on CI runners
  expect(await page.getByTestId('candidate').count()).toBeLessThan(200);
  await expect(page.getByTestId('candidate').last()).toBeVisible();

  // Untick one candidate → chip counts update
  await viewport.evaluate((el) => (el.scrollTop = 0));
  await page.getByTestId('candidate').first().getByRole('checkbox').click();
  await expect(page.getByRole('option', { name: /Unticked \(1\)/ })).toBeVisible();

  // Apply is a placeholder until phase 5
  await page.getByTestId('apply').click();
  await expect(page.getByRole('dialog')).toContainText('phase 5');
  await page.getByRole('button', { name: 'OK' }).click();

  // Dashboard shows the last run
  await page.getByRole('link', { name: 'Jobs', exact: true }).click();
  await expect(page.locator('app-status-chip')).toContainText('Succeeded');

  expect(errors).toEqual([]);
});

test('shows field errors from the server', async ({ page }) => {
  await page.goto('/jobs/new');
  await page.getByTestId('job-name').fill('Bad schedule');
  await page.getByTestId('target-album').fill('X');
  await page.getByPlaceholder('0 3 * * *').fill('every day');
  await page.getByTestId('save-job').click();
  await expect(page.getByText('must be a valid cron expression')).toBeVisible();
  await expect(page).toHaveURL(/\/jobs\/new$/);
});
