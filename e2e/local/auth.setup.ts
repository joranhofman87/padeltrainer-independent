import { test as setup, expect } from '@playwright/test';
import { authFile, LOGINS, PASSWORD } from './authState';

/**
 * Logs in the seeded roles through the REAL UI (so the Supabase session lands in localStorage
 * under the correct key) and saves each storageState. Authed specs opt in via
 * `test.use({ storageState: authFile('manager') })`. Runs as a Playwright "setup" project that
 * the authed run depends on. Needs `npm run db:seed:local` (the *@local.test logins).
 */
for (const [role, email] of Object.entries(LOGINS)) {
  setup(`login as ${role}`, async ({ page }) => {
    await page.goto('/app/auth');
    await page.locator('input[type="email"]:visible').fill(email);
    await page.locator('input[type="password"]:visible').fill(PASSWORD);
    await page.getByTestId('auth-login-button').click();
    // Success signal = the Supabase session lands in localStorage (independent of where the
    // app's role-routing then redirects). storageState captures that session for authed specs.
    await expect
      .poll(() => page.evaluate(() => Object.keys(localStorage).some((k) => k.includes('auth-token'))), { timeout: 20_000 })
      .toBe(true);
    await page.context().storageState({ path: authFile(role) });
  });
}
