// @vitest-environment node
//
// ABC-18 Pass B §1b — invoice recipient identity, email and delivery status.
//
// The adversarial shape throughout: a DUAL-KEY invoice — a guest's invoice carrying some
// account's stale player_id — plus a SECOND guest sharing that same stale profile. Profile-first
// resolution routes the first guest's money and mail to the account, and collapses the two guests.
//
// Every re-emitted PL/pgSQL body is EXECUTED here; the migration applying is not evidence.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { applyPreH0, applyH0, FIXTURE_SQL, IDS } from './abc16Fixture';

let db: PGlite;

const ACCOUNT_PROFILE = IDS.bookedProfile;          // the stale player_id both guests carry
const ACCOUNT_EMAIL = 'account.holder@example.test';
const GUEST_A = '2c000000-0000-4000-8000-0000000000b1';
const GUEST_B = '2c000000-0000-4000-8000-0000000000b2';
const GUEST_NO_EMAIL = '2c000000-0000-4000-8000-0000000000b3';
const PURE_PROFILE = IDS.nascentProfile;

beforeAll(async () => {
  db = new PGlite();
  const exec = (sql: string) => db.exec(sql);
  await applyPreH0(exec);
  await db.exec(FIXTURE_SQL);
  await applyH0(exec);

  await db.exec(`
    UPDATE public.profiles
       SET email = '${ACCOUNT_EMAIL}', phone = '0600000000',
           billing_business_name = 'Account BV', billing_address = 'Account Street 1'
     WHERE id = '${ACCOUNT_PROFILE}';

    -- two guests sharing the stale profile; one has no email of its own
    INSERT INTO public.guest_players
      (id, full_name, email, phone, academy_profile_id, linked_profile_id,
       billing_business_name, billing_address) VALUES
      ('${GUEST_A}', 'Guest Alpha', 'alpha@example.test', '0611111111',
       '${IDS.attackerAcademy}', '${ACCOUNT_PROFILE}', 'Alpha BV', 'Alpha Street 1'),
      ('${GUEST_B}', 'Guest Beta',  'beta@example.test',  '0622222222',
       '${IDS.attackerAcademy}', '${ACCOUNT_PROFILE}', NULL, NULL),
      ('${GUEST_NO_EMAIL}', 'Guest NoMail', '', NULL,
       '${IDS.attackerAcademy}', '${ACCOUNT_PROFILE}', NULL, NULL);

    -- a caller-authored billing override that used to win over everything
    INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, billing_email)
      VALUES ('${IDS.attackerAcademy}', '${GUEST_A}', 'override@attacker.test');
  `);
}, 120_000);

const identity = async (playerId: string | null, guestId: string | null) => {
  const r = await db.query<{
    full_name: string; email: string; phone: string;
    billing_business_name: string | null; billing_address: string | null;
  }>(`SELECT * FROM public.get_invoice_recipient_identity($1::uuid, $2::uuid, $3::uuid)`,
    [playerId, guestId, IDS.attackerAcademy]);
  return r.rows;
};

describe('§1b · get_invoice_recipient_identity is guest-first', () => {
  it('a DUAL-KEY call resolves to the GUEST, not the accompanying account', async () => {
    const [row] = await identity(ACCOUNT_PROFILE, GUEST_A);
    expect(row.full_name).toBe('Guest Alpha');
    expect(row.email).toBe('alpha@example.test');
    expect(row.email).not.toBe(ACCOUNT_EMAIL);
  });

  it('…and takes the guest\'s own phone and billing, not the account\'s', async () => {
    const [row] = await identity(ACCOUNT_PROFILE, GUEST_A);
    expect(row.phone).toBe('0611111111');
    expect(row.billing_business_name).toBe('Alpha BV');
    expect(row.billing_address).toBe('Alpha Street 1');
  });

  it('a caller-authored metadata billing override no longer redirects the invoice', async () => {
    const [row] = await identity(ACCOUNT_PROFILE, GUEST_A);
    expect(row.email).not.toBe('override@attacker.test');
  });

  it('two guests sharing the stale profile remain distinct', async () => {
    const [a] = await identity(ACCOUNT_PROFILE, GUEST_A);
    const [b] = await identity(ACCOUNT_PROFILE, GUEST_B);
    expect(a.email).toBe('alpha@example.test');
    expect(b.email).toBe('beta@example.test');
    expect(a.full_name).not.toBe(b.full_name);
  });

  it('a guest WITHOUT its own email is unresolved — never rerouted to the account', async () => {
    const [row] = await identity(ACCOUNT_PROFILE, GUEST_NO_EMAIL);
    expect(row.email).toBe('');
    expect(row.email).not.toBe(ACCOUNT_EMAIL);
    expect(row.full_name).toBe('Guest NoMail');   // display still works
  });

  it('a PURE-PROFILE call still resolves to the profile', async () => {
    await db.exec(`UPDATE public.profiles SET email = 'pure@example.test' WHERE id = '${PURE_PROFILE}'`);
    const [row] = await identity(PURE_PROFILE, null);
    expect(row.email).toBe('pure@example.test');
  });

  it('neither id yields NO row — unresolved, not a default', async () => {
    expect(await identity(null, null)).toEqual([]);
  });

  it('MUTATION: the profile arm must require guest NULL', async () => {
    // If that conjunction were dropped, a dual-key call would emit TWO rows (guest + profile)
    // and the caller's [0] pick would become order-dependent — the classic silent reroute.
    const rows = await identity(ACCOUNT_PROFILE, GUEST_A);
    expect(rows).toHaveLength(1);
  });
});

describe('§1b · get_invoices_delivery_status uses the same recipient', () => {
  const INV_DUAL = '1c000000-0000-4000-8000-0000000000b1';
  const INV_NOMAIL = '1c000000-0000-4000-8000-0000000000b2';

  beforeAll(async () => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS public.email_suppressions (
        email text PRIMARY KEY, reason text
      );
      INSERT INTO public.invoices (id, trainer_id, academy_profile_id, player_id, guest_player_id, status, sent_at)
      VALUES
        ('${INV_DUAL}',   NULL, '${IDS.attackerAcademy}', '${ACCOUNT_PROFILE}', '${GUEST_A}', 'sent', now()),
        ('${INV_NOMAIL}', NULL, '${IDS.attackerAcademy}', '${ACCOUNT_PROFILE}', '${GUEST_NO_EMAIL}', 'sent', now());
      INSERT INTO public.email_suppressions (email, reason) VALUES ('alpha@example.test', 'hard_bounce');
    `);
  });

  const status = async (uid: string, ids: string[]) => {
    await db.query(`SELECT set_config('abc16.uid', $1, false)`, [uid]);
    const r = await db.query<{ invoice_id: string; recipient_email: string; delivery_state: string }>(
      `SELECT * FROM public.get_invoices_delivery_status($1::uuid[])`, [ids]);
    return r.rows;
  };

  it('reports the GUEST\'s address and its real bounce state', async () => {
    const rows = await status(IDS.attackerUser, [INV_DUAL]);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_email).toBe('alpha@example.test');
    expect(rows[0].delivery_state).toBe('undeliverable');   // genuine provider suppression
  });

  it('a guest with no address reports no_email, not the account\'s address', async () => {
    const rows = await status(IDS.attackerUser, [INV_NOMAIL]);
    expect(rows[0].recipient_email).toBe('');
    expect(rows[0].delivery_state).toBe('no_email');
  });

  it('the tenant gate still refuses an outsider', async () => {
    expect(await status(IDS.victimUser, [INV_DUAL, INV_NOMAIL])).toEqual([]);
  });
});
