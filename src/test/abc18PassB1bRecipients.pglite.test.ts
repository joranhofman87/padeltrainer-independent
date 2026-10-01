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
  const INV_DUAL = '1c000000-0000-4000-8000-0000000000b1';    // guest address hard-bounced
  const INV_NOMAIL = '1c000000-0000-4000-8000-0000000000b2';  // guest has no address at all
  const INV_PROV = '1c000000-0000-4000-8000-0000000000b3';    // guest address provider-suppressed
  const INV_CLEAN = '1c000000-0000-4000-8000-0000000000b4';   // guest address known-good, sent
  const INV_UNSENT = '1c000000-0000-4000-8000-0000000000b5';  // guest address known-good, not sent
  const INV_MIXED = '1c000000-0000-4000-8000-0000000000b6';   // guest address stored MIXED-CASE
  const GUEST_CLEAN = '2c000000-0000-4000-8000-0000000000b4';
  const GUEST_MIXED = '2c000000-0000-4000-8000-0000000000b5';

  beforeAll(async () => {
    await db.exec(`
      -- A fourth guest with a KNOWN-GOOD address, carrying the same stale account as the others.
      INSERT INTO public.guest_players (id, full_name, email, academy_profile_id, linked_profile_id) VALUES
        ('${GUEST_CLEAN}', 'Guest Clean', 'clean@example.test',
         '${IDS.attackerAcademy}', '${ACCOUNT_PROFILE}'),
        -- stored with capitals and surrounding whitespace, as real user-entered addresses are
        ('${GUEST_MIXED}', 'Guest Mixed', '  Mixed.Case@Example.Test  ',
         '${IDS.attackerAcademy}', '${ACCOUNT_PROFILE}');

      INSERT INTO public.invoices (id, trainer_id, academy_profile_id, player_id, guest_player_id, status, sent_at)
      VALUES
        ('${INV_DUAL}',   NULL, '${IDS.attackerAcademy}', '${ACCOUNT_PROFILE}', '${GUEST_A}', 'sent', now()),
        ('${INV_NOMAIL}', NULL, '${IDS.attackerAcademy}', '${ACCOUNT_PROFILE}', '${GUEST_NO_EMAIL}', 'sent', now()),
        ('${INV_PROV}',   NULL, '${IDS.attackerAcademy}', '${ACCOUNT_PROFILE}', '${GUEST_B}', 'sent', now()),
        ('${INV_CLEAN}',  NULL, '${IDS.attackerAcademy}', '${ACCOUNT_PROFILE}', '${GUEST_CLEAN}', 'sent', now()),
        ('${INV_UNSENT}', NULL, '${IDS.attackerAcademy}', '${ACCOUNT_PROFILE}', '${GUEST_CLEAN}', 'draft', NULL),
        ('${INV_MIXED}',  NULL, '${IDS.attackerAcademy}', '${ACCOUNT_PROFILE}', '${GUEST_MIXED}', 'sent', now());

      -- Suppression comes from the TRACKED authority, email_address_state, whose is_suppressed is
      -- a GENERATED column: the rows below set the two independent axes it is derived from, so a
      -- reader that consulted the raw \`state\` instead would disagree with a reader that consults
      -- is_suppressed — which is exactly what the provider-suppressed row discriminates.
      INSERT INTO public.email_address_state (email, state, provider_suppressed_active) VALUES
        ('alpha@example.test',         'hard_bounced', false),  -- bounce axis
        ('beta@example.test',          'ok',           true),   -- provider-suppression axis only
        ('clean@example.test',         'ok',           false),  -- present but NOT suppressed
        -- email_address_state.email is a LOWERCASE-NORMALIZED primary key: the suppression row
        -- for the mixed-case guest is keyed lowercase, as record_email_event always writes it.
        ('mixed.case@example.test',    'hard_bounced', false),
        ('${ACCOUNT_EMAIL}',           'hard_bounced', true);   -- the ACCOUNT is undeliverable
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

  it('a PROVIDER suppression with no bounce is undeliverable too — the canonical predicate', async () => {
    // beta@ has state='ok'. A reader deriving suppression from `state` alone would call this
    // 'sent' and the academy would keep mailing an address Resend refuses to deliver to.
    const rows = await status(IDS.attackerUser, [INV_PROV]);
    expect(rows[0].recipient_email).toBe('beta@example.test');
    expect(rows[0].delivery_state).toBe('undeliverable');
  });

  it('DISCRIMINATING CONTROL: a known-good address reports sent, not undeliverable', async () => {
    // clean@ HAS a row in email_address_state. If the predicate degraded to "a row exists",
    // every tracked address on the platform would read as undeliverable and the two arms above
    // would pass for the wrong reason.
    const rows = await status(IDS.attackerUser, [INV_CLEAN]);
    expect(rows[0].recipient_email).toBe('clean@example.test');
    expect(rows[0].delivery_state).toBe('sent');
  });

  it('…and the account\'s OWN suppression never leaks onto the guest\'s state', async () => {
    // INV_CLEAN carries the stale ACCOUNT player_id, and that account address is hard-bounced
    // AND provider-suppressed. Account-first resolution would report 'undeliverable' here.
    const rows = await status(IDS.attackerUser, [INV_CLEAN]);
    expect(rows[0].recipient_email).not.toBe(ACCOUNT_EMAIL);
    expect(rows[0].delivery_state).not.toBe('undeliverable');
  });

  it('a MIXED-CASE recipient address still matches its normalized suppression row', async () => {
    // email_address_state.email is the lowercase-normalized PRIMARY KEY. A lookup that failed to
    // lower/btrim the recipient address would find no row and report this hard-bounced guest as
    // deliverable — the academy would keep mailing an address that bounces. Every other address
    // in this suite is already lowercase, so without this arm that regression is invisible.
    const rows = await status(IDS.attackerUser, [INV_MIXED]);
    expect(rows[0].delivery_state).toBe('undeliverable');
  });

  it('an unsent invoice to a deliverable address is not_sent', async () => {
    const rows = await status(IDS.attackerUser, [INV_UNSENT]);
    expect(rows[0].delivery_state).toBe('not_sent');
  });

  it('a guest with no address reports no_email, not the account\'s address', async () => {
    const rows = await status(IDS.attackerUser, [INV_NOMAIL]);
    expect(rows[0].recipient_email).toBe('');
    expect(rows[0].delivery_state).toBe('no_email');
  });

  it('the tenant gate still refuses an outsider', async () => {
    expect(await status(IDS.victimUser, [INV_DUAL, INV_NOMAIL, INV_CLEAN])).toEqual([]);
  });

  it('the reader resolves suppression through the TRACKED authority, not an invented relation', async () => {
    const r = await db.query<{ src: string }>(`
      SELECT p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'get_invoices_delivery_status'`);
    expect(r.rows[0].src).toContain('email_address_state');
    expect(r.rows[0].src).toContain('is_suppressed');
    expect(r.rows[0].src).not.toContain('email_suppressions');
  });

  it('ACL: anon cannot execute it; authenticated and service_role can', async () => {
    // The result-shape repair DROPs the predecessor, which discards its ACL — and the platform
    // default privileges then re-grant EXECUTE to PUBLIC and anon. Without the re-emitted
    // REVOKE/GRANT this SECURITY DEFINER, tenant-gated invoice reader is anonymously callable.
    const r = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(`
      SELECT has_function_privilege('anon',          'public.get_invoices_delivery_status(uuid[])', 'EXECUTE') AS anon,
             has_function_privilege('authenticated', 'public.get_invoices_delivery_status(uuid[])', 'EXECUTE') AS auth,
             has_function_privilege('service_role',  'public.get_invoices_delivery_status(uuid[])', 'EXECUTE') AS svc`);
    expect(r.rows[0]).toEqual({ anon: false, auth: true, svc: true });
  });

  it('it is still SECURITY DEFINER on a pinned search path, with the §1b result shape', async () => {
    const r = await db.query<{ secdef: boolean; cfg: string[] | null; args: string; result: string }>(`
      SELECT p.prosecdef AS secdef, p.proconfig AS cfg,
             pg_get_function_identity_arguments(p.oid) AS args,
             pg_get_function_result(p.oid) AS result
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'get_invoices_delivery_status'`);
    expect(r.rows[0].secdef).toBe(true);
    expect(r.rows[0].cfg).toContain('search_path=public');
    expect(r.rows[0].args).toBe('_invoice_ids uuid[]');
    expect(r.rows[0].result).toBe(
      'TABLE(invoice_id uuid, recipient_email text, delivery_state text)');
  });
});
