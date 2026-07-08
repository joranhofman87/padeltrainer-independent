import { test, expect } from '@playwright/test';
import { authFile } from './authState';

/**
 * Academy dashboard + reports render on seeded data (local stack). Guards the class of bug seen
 * before: a fill-rate ("bezetting") over 100% or otherwise nonsensical stats. No edge functions
 * needed — the analytics are SQL RPCs.
 */
test.use({ storageState: authFile('manager') });

test('academy dashboard loads for the manager', async ({ page }) => {
  await page.goto('/app/academy');
  await page.waitForLoadState('networkidle');
  await expect(page).not.toHaveURL(/\/app\/auth/);
  // The dashboard rendered (its h1) — the analytics RPCs resolved for the manager without error.
  await expect(page.getByRole('heading', { name: /academy dashboard/i, level: 1 })).toBeVisible();
});

test('reports tab loads with a sane fill-rate (no bezetting > 100%)', async ({ page }) => {
  await page.goto('/app/academy/calendar?tab=reports');
  await page.waitForLoadState('networkidle');
  await expect(page).not.toHaveURL(/\/app\/auth/);
  // #412 regression guard: no percentage over 100% anywhere in the reports.
  const body = await page.locator('body').innerText();
  const over100 = [...body.matchAll(/(\d{3,})\s*%/g)].map((m) => Number(m[1])).filter((n) => n > 100);
  expect(over100, `percent over 100% on the reports tab: ${JSON.stringify(over100)}`).toEqual([]);
});
