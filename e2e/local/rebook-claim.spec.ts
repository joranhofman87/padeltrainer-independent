import { test, expect } from '@playwright/test';

/**
 * LOCAL-stack E2E (needs `supabase start` + `npm run db:seed:local`, dev server on the e2e env —
 * run via `npm run e2e:local`). Drives the never-logged-in rebook flow end to end against real
 * seeded data: open the claim link → see the Dutch card → accept → the REAL
 * respond_to_priority_claim RPC reserves the spot. The seed mints this deterministic token; the
 * accept mutates it to 'claimed', so a re-run expects a fresh `db:seed:local`.
 */
const TOKEN = 'seed-claim-a0-s0-p1';

test('never-logged-in claim → accept reserves the spot', async ({ page }) => {
  await page.goto(`/nl/claim/${TOKEN}`);

  // The academy's new round + the invitee resolve from get_priority_claim_by_token.
  await expect(page.getByText(/Najaar 0/i)).toBeVisible();
  await expect(page.getByText(/Player 1-0/i)).toBeVisible();
  // Deferred copy (pay-later), not upfront.
  await expect(page.getByText(/betaalt pas|only pay when/i)).toBeVisible();

  // Accept → respond_to_priority_claim commits a confirmed unpaid booking and flips the claim
  // to 'claimed', so the page shows the reserved confirmation.
  await page.getByRole('button', { name: /hou mijn plek|keep my spot/i }).click();
  // Both a success toast and the persistent on-page state say "gereserveerd" — first() avoids
  // the strict-mode multi-match; either being visible proves the accept committed.
  await expect(page.getByText(/gereserveerd|reserved/i).first()).toBeVisible({ timeout: 15_000 });
});
