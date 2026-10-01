// @vitest-environment node
//
// ABC-20 — the claim-token and resume-payment boundaries, exercised for real.
//
// The rule is FAM-02, the same one personRefOf encodes in TS: a row carrying BOTH identity
// columns belongs to the GUEST. These call the RPCs and assert what they RETURN, because the
// defect was a resolution ORDER inside them — a source scan would not have caught the
// consequence, which is that a guest token receives another person's payment page.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { applyPreH0, applyH0, FIXTURE_SQL, IDS } from './abc16Fixture';

let db: PGlite;

const CYCLUS = '9d000000-0000-4000-8000-000000000001';
const SLOT = '3d000000-0000-4000-8000-000000000001';
const DUAL_TOKEN = 'tok-dual-key';
const PURE_TOKEN = 'tok-pure-profile';
const GUEST_ONLY_TOKEN = 'tok-guest-only';
const ORPHAN_TOKEN = 'tok-no-identity';

const GUEST = IDS.guestOwnedByAttackerAcademy;
const PROFILE = IDS.bookedProfile;

beforeAll(async () => {
  db = new PGlite();
  const exec = (sql: string) => db.exec(sql);
  await applyPreH0(exec);
  await db.exec(FIXTURE_SQL);
  await applyH0(exec);

  await db.exec(`
    INSERT INTO public.cycles (id, owner_type, owner_id, type)
      VALUES ('${CYCLUS}', 'academy', '${IDS.attackerAcademy}', 'cyclus');
    INSERT INTO public.availability_slots (id, academy_profile_id, cyclus_id, start_time)
      VALUES ('${SLOT}', '${IDS.attackerAcademy}', '${CYCLUS}', now() + interval '3 days');

    -- the three claim shapes plus an unscoped one
    INSERT INTO public.slot_priority_claims (slot_id, player_id, guest_player_id, status, claim_token) VALUES
      ('${SLOT}', '${PROFILE}', '${GUEST}', 'pending', '${DUAL_TOKEN}'),
      ('${SLOT}', '${PROFILE}', NULL,       'pending', '${PURE_TOKEN}'),
      ('${SLOT}', NULL,         '${GUEST}', 'pending', '${GUEST_ONLY_TOKEN}'),
      ('${SLOT}', NULL,         NULL,       'pending', '${ORPHAN_TOKEN}');

    -- a PURE-PROFILE invoice for that profile: the row a dual-key guest token must never reach
    INSERT INTO public.invoices
      (rebook_cyclus_id, player_id, guest_player_id, status, public_token)
      VALUES ('${CYCLUS}', '${PROFILE}', NULL, 'sent', 'PUBLIC-TOKEN-PROFILE');
  `);
}, 120_000);

const claimByToken = async (token: string) => {
  const r = await db.query<{ v: Record<string, unknown> }>(
    `SELECT public.get_priority_claim_by_token($1) AS v`, [token]);
  return r.rows[0].v as { claim: Record<string, unknown>; player_name: string } | null;
};

const resumeToken = async (token: string) => {
  const r = await db.query<{ v: { public_token: string } | null }>(
    `SELECT public.get_unpaid_rebook_invoice_by_claim_token($1) AS v`, [token]);
  return r.rows[0].v;
};

describe('ABC-20 · get_priority_claim_by_token supplies the identity', () => {
  it('exposes both columns so the caller can resolve guest-first', async () => {
    const dual = await claimByToken(DUAL_TOKEN);
    expect(dual!.claim.player_id).toBe(PROFILE);
    expect(dual!.claim.guest_player_id).toBe(GUEST);
  });

  it('a pure-profile claim carries a null guest column', async () => {
    const pure = await claimByToken(PURE_TOKEN);
    expect(pure!.claim.player_id).toBe(PROFILE);
    expect(pure!.claim.guest_player_id).toBeNull();
  });

  it('names a dual-key claim after the GUEST, not the account holder', async () => {
    const dual = await claimByToken(DUAL_TOKEN);
    expect(dual!.player_name).toBe('Own Guest');
    expect(dual!.player_name).not.toBe('Booked Player');
  });

  it('still names a pure-profile claim after the profile', async () => {
    const pure = await claimByToken(PURE_TOKEN);
    expect(pure!.player_name).toBe('Booked Player');
  });
});

describe('ABC-20 · get_unpaid_rebook_invoice_by_claim_token is guest-first', () => {
  it('a DUAL-KEY guest token is NOT handed the pure-profile invoice token', async () => {
    // The defect: profile-first resolution matched i.player_id and returned this other person's
    // payment page — their amount, their seats.
    expect(await resumeToken(DUAL_TOKEN)).toBeNull();
  });

  it('a guest-only token is not handed it either', async () => {
    expect(await resumeToken(GUEST_ONLY_TOKEN)).toBeNull();
  });

  it('the PURE-PROFILE token still resumes its own invoice', async () => {
    const r = await resumeToken(PURE_TOKEN);
    expect(r?.public_token).toBe('PUBLIC-TOKEN-PROFILE');
  });

  it('a claim with neither identity fails closed', async () => {
    expect(await resumeToken(ORPHAN_TOKEN)).toBeNull();
  });

  it('a guest token DOES resume its own guest invoice', async () => {
    await db.exec(`
      INSERT INTO public.invoices (rebook_cyclus_id, player_id, guest_player_id, status, public_token)
      VALUES ('${CYCLUS}', NULL, '${GUEST}', 'sent', 'PUBLIC-TOKEN-GUEST');
    `);
    expect((await resumeToken(GUEST_ONLY_TOKEN))?.public_token).toBe('PUBLIC-TOKEN-GUEST');
    // and the dual-key token resolves to the SAME guest — one person, one invoice
    expect((await resumeToken(DUAL_TOKEN))?.public_token).toBe('PUBLIC-TOKEN-GUEST');
  });

  it('the profile branch cannot reach a guest\'s DUAL-KEY invoice', async () => {
    // a dual-key invoice naming the same profile: the pure-profile token must not resume it
    await db.exec(`
      UPDATE public.invoices SET public_token = NULL WHERE public_token = 'PUBLIC-TOKEN-PROFILE';
      INSERT INTO public.invoices (rebook_cyclus_id, player_id, guest_player_id, status, public_token)
      VALUES ('${CYCLUS}', '${PROFILE}', '${IDS.guestOwnedByVictimAcademy}', 'sent', 'PUBLIC-TOKEN-DUAL');
    `);
    expect(await resumeToken(PURE_TOKEN)).toBeNull();
  });
});
