import { test, expect } from '@playwright/test';
import { authFile } from './authState';

/** Authed as the seeded academy manager (storageState from auth.setup). Confirms the login
 *  session reaches the academy area — the gate for all academy-side E2E (wizard, dashboards). */
test.use({ storageState: authFile('manager') });

test('academy manager reaches the academy area (not bounced to /auth)', async ({ page }) => {
  await page.goto('/app/academy');
  await page.waitForLoadState('networkidle');
  await expect(page).not.toHaveURL(/\/app\/auth/);
});
