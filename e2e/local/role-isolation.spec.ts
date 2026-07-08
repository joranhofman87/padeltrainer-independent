import { test, expect } from '@playwright/test';
import { authFile } from './authState';

/**
 * Role isolation (local stack + seeded logins): each seeded role reaches its OWN area and is kept
 * OUT of the others. Uses the saved storageState per role. A failure here is a real access-control
 * finding, not a flake.
 */
async function open(browser: import('@playwright/test').Browser, role: string, path: string) {
  const ctx = await browser.newContext({ storageState: authFile(role) });
  const page = await ctx.newPage();
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  return { ctx, page };
}

test('academy manager reaches the academy area', async ({ browser }) => {
  const { ctx, page } = await open(browser, 'manager', '/app/academy');
  await expect(page).not.toHaveURL(/\/app\/auth/);
  await ctx.close();
});

test('trainer reaches the trainer area', async ({ browser }) => {
  const { ctx, page } = await open(browser, 'trainer', '/app/trainer');
  await expect(page).not.toHaveURL(/\/app\/auth/);
  await ctx.close();
});

test('player reaches the player area', async ({ browser }) => {
  const { ctx, page } = await open(browser, 'player', '/app/player');
  await expect(page).not.toHaveURL(/\/app\/auth/);
  await ctx.close();
});

test('a player is kept OUT of the academy area', async ({ browser }) => {
  const { ctx, page } = await open(browser, 'player', '/app/academy');
  // Blocked = does not linger on the academy area showing its dashboard. Either redirected away,
  // or the academy dashboard's "Quick navigation" chrome is not rendered for a non-manager.
  const onAcademy = /\/app\/academy(\/|$|\?)/.test(page.url());
  const seesAcademyChrome = await page.getByRole('heading', { name: /quick nav|snelnav|navigatie/i }).isVisible().catch(() => false);
  expect(onAcademy && seesAcademyChrome, `player saw academy dashboard at ${page.url()}`).toBe(false);
  await ctx.close();
});
