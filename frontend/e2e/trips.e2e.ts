import { expect, test, type Page } from '@playwright/test';

/** The stack runs with APP_PASSWORD=e2e. */
async function signIn(page: Page, path = '/') {
  await page.goto(path);
  await expect(page).toHaveURL(/\/login/);
  await page.getByTestId('password').fill('e2e');
  await page.getByTestId('login').click();
}

/**
 * Trip albums (trip-albums plan T5): create the job, dry-run it, review the
 * trips, untick one, apply, and see the trips on the job page. The stack's
 * trip library (e2e/stack.mjs) has Bangkok in March and Prague in April.
 */
test('create a trip job, review trips, apply and manage them', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await signIn(page, '/jobs/new');
  await expect(page).toHaveURL(/\/jobs\/new$/);

  // Trip albums: no target album; params form with collapsed advanced settings.
  await page.getByTestId('job-type').click();
  await page.getByRole('option', { name: 'Trip albums' }).click();
  await expect(page.getByTestId('target-album')).toHaveCount(0);
  await expect(page.getByTestId('params-form')).toContainText('Away rule');
  const advanced = page.getByTestId('params-advanced');
  await expect(advanced).toBeVisible();
  await expect(advanced).not.toHaveAttribute('open');
  await page.getByTestId('job-name').fill('Trips');
  await page.getByTestId('save-job').click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('trips-panel')).toContainText('No trips yet');

  // Dry run → trip review.
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Review trips' })).toBeVisible();
  const trips = page.getByTestId('trip');
  await expect(trips).toHaveCount(2);
  await expect(page.getByTestId('trip-name')).toHaveText([
    'Thailand – Mar 2026',
    'Czechia – Apr 2026',
  ]);
  await expect(page.getByTestId('trip-badge')).toHaveText(['New', 'New']);
  await expect(page.getByTestId('trip-summary')).toHaveText('2 new');
  await expect(trips.first()).toContainText('Bangkok');

  // The photos of a trip, with why they are in it.
  await trips.first().getByTestId('trip-expand').click();
  await expect(page.getByTestId('trip-asset').first()).toBeVisible();
  await expect(page.getByTestId('trip-asset').first()).toContainText('away');

  // Untick Prague, apply.
  await trips.nth(1).getByTestId('trip-check').click();
  await expect(trips.nth(1)).toHaveClass(/unticked/);
  await page.getByTestId('apply-trips').click();
  await expect(page.getByRole('dialog')).toContainText('1 new album will be created');
  await expect(page.getByRole('dialog')).toContainText('1 unticked trip will be ignored');
  await page.getByRole('button', { name: 'Apply 1 trip' }).click();
  await expect(page.getByText(/Album sync: 1 albums created/)).toBeVisible();
  await expect(page.getByTestId('applied-at')).toBeVisible();
  await expect(page.getByTestId('apply-trips')).toBeDisabled();

  // Job page: trips with status; Prague can be reactivated.
  await page.getByRole('link', { name: 'Back to job' }).click();
  const rows = page.getByTestId('trip-row');
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId('trip-status')).toHaveText(['Active', 'Ignored']);
  await expect(rows.first()).toContainText('Thailand – Mar 2026');
  await expect(page.getByTestId('home-panel')).toContainText('Germany');
  await rows.nth(1).getByTestId('trip-actions').click();
  await page.getByRole('menuitem', { name: 'Activate' }).click();
  await expect(page.getByTestId('trip-status')).toHaveText(['Active', 'Active']);

  expect(errors).toEqual([]);
});
