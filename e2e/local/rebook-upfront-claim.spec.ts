import { test, expect } from '@playwright/test';

/**
 * LOCAL-stack E2E for the LAUNCH scenario: an academy-created player opens their rebook invite for
 * an UPFRONT cycle and must see "pay now" + the FULL price for the FULL cycle (no split). Covers a
 * registered player AND a guest (many academy-created players are guests). Drives the public claim
 * page (no login) against seeded data; the seed groups each invitee's two weekly claims so
 * sessions=2 → whole-term total = €40 (2 × €20). The actual Mollie pay step is a separate spec
 * gated on a Mollie test key (see plan). Needs `npm run db:seed:local`.
 */
async function assertUpfrontFullCycle(page: import('@playwright/test').Page, token: string, name: string) {
  await page.goto(`/nl/claim/${token}`);
  await expect(page.getByText(name)).toBeVisible();
  // Upfront = pay-now copy (never the deferred/split copy).
  await expect(page.getByText(/je betaalt direct/i)).toBeVisible();
  await expect(page.getByText(/wordt gedeeld|split between/i)).toHaveCount(0);
  // Full price for the full cycle: €20 × 2 sessions = €40,00 for the whole term.
  await expect(page.getByText(/voor de hele termijn/i)).toBeVisible();
  await expect(page.getByText(/40,00/)).toBeVisible();
}

test('upfront rebook claim — registered player sees pay-now + full-cycle price', async ({ page }) => {
  await assertUpfrontFullCycle(page, 'seed-claim-up-a0-s0-p1', 'Player 1-0');
});

test('upfront rebook claim — academy-created guest sees pay-now + full-cycle price', async ({ page }) => {
  await assertUpfrontFullCycle(page, 'seed-claim-up-a0-s0-g1', 'Guest 1-0');
});
