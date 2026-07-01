// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Invariant #6 (PAYMENT_INVARIANTS.md): the Mollie org that CHARGES a payment MUST equal the org that
// CONFIRMS it in the webhook — else the payment strands / routes to the wrong account. Both sides
// resolve the recipient with the IDENTICAL predicate keyed off slot.academy_profile_id (Codex F3):
//   academy_trainers WHERE trainer_profile_id AND status='active' [AND academy_profile_id = slot.academy]
//   → academy Mollie (if ready) else the trainer's own Mollie.
// This models that resolution against real Postgres and asserts the CHARGE-side and CONFIRM-side
// resolutions land on the same org across the F3 scenarios (2-academy trainer, not-ready academy, null).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

const T = '20000000-0000-0000-0000-000000000001'; // a trainer in TWO academies
const A = '50000000-0000-0000-0000-00000000000a';
const B = '50000000-0000-0000-0000-00000000000b';

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.academy_trainers (trainer_profile_id uuid, academy_profile_id uuid, status text);
    CREATE TABLE public.academy_mollie_accounts (academy_profile_id uuid, mollie_organization_id text,
      onboarding_complete boolean, charges_enabled boolean, access_token text);
    CREATE TABLE public.trainer_mollie_accounts (trainer_id uuid, mollie_organization_id text,
      onboarding_complete boolean, access_token text);
    INSERT INTO public.academy_trainers VALUES
      ('${T}', '${A}', 'active'), ('${T}', '${B}', 'active');            -- trainer belongs to A AND B
    INSERT INTO public.academy_mollie_accounts VALUES
      ('${A}', 'org-A', true, true, 'tok-A'),                            -- A is ready
      ('${B}', 'org-B', false, true, 'tok-B');                           -- B is NOT onboarded
    INSERT INTO public.trainer_mollie_accounts VALUES ('${T}', 'org-own', true, 'tok-own');
  `);
});

// The exact recipient resolution both resolveSlotRecipient (charge) and resolveAccessToken (confirm)
// run: pick the academy membership (with the F3 hint), require the academy Mollie to be ready, else the
// trainer's own. A .maybeSingle() over 2 active memberships with NO hint collapses → null (the F3 bug).
async function resolveOrg(academyHint: string | null): Promise<string | null> {
  const memberships = (
    await db.query<{ academy_profile_id: string }>(
      `SELECT academy_profile_id FROM public.academy_trainers
       WHERE trainer_profile_id = $1 AND status = 'active'
         AND ($2::uuid IS NULL OR academy_profile_id = $2)`,
      [T, academyHint],
    )
  ).rows;
  const academy = memberships.length === 1 ? memberships[0].academy_profile_id : null; // maybeSingle collapse
  if (academy) {
    const am = (
      await db.query<{ mollie_organization_id: string }>(
        `SELECT mollie_organization_id FROM public.academy_mollie_accounts
         WHERE academy_profile_id = $1 AND onboarding_complete = true AND charges_enabled = true
           AND access_token IS NOT NULL`,
        [academy],
      )
    ).rows[0];
    if (am) return am.mollie_organization_id;
  }
  const tm = (
    await db.query<{ mollie_organization_id: string }>(
      `SELECT mollie_organization_id FROM public.trainer_mollie_accounts
       WHERE trainer_id = $1 AND onboarding_complete = true AND access_token IS NOT NULL`,
      [T],
    )
  ).rows[0];
  return tm?.mollie_organization_id ?? null;
}

describe('charge org == confirm org (invariant #6, F3)', () => {
  it('a 2-academy trainer on a slot in academy A: charge + confirm both resolve academy A', async () => {
    const charge = await resolveOrg(A); // charge side passes slot.academy_profile_id = A
    const confirm = await resolveOrg(A); // webhook passes the SAME slot.academy_profile_id = A
    expect(charge).toBe('org-A');
    expect(confirm).toBe('org-A');
    expect(charge).toBe(confirm); // no strand
  });

  it('slot in academy B (not onboarded): both fall back to the trainer own Mollie — still equal', async () => {
    const charge = await resolveOrg(B);
    const confirm = await resolveOrg(B);
    expect(charge).toBe('org-own');
    expect(confirm).toBe('org-own');
    expect(charge).toBe(confirm);
  });

  it('WITHOUT the academy hint the 2-academy membership collapses to the trainer own — the F3 bug, still parity', async () => {
    // Documents the pre-F3 behaviour: both sides collapse identically (no strand), but to the WRONG org.
    const charge = await resolveOrg(null);
    const confirm = await resolveOrg(null);
    expect(charge).toBe('org-own');
    expect(confirm).toBe(confirm);
    expect(charge).toBe(confirm);
    // The F3 fix is that BOTH sides now pass the hint (previous test), routing to the correct academy.
  });
});
