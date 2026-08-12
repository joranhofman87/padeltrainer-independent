// @vitest-environment node
//
// Pass B §2 — guest/account contact separation, executed.
//
// The adversarial shape is the one the legacy bridge actually produced: TWO different guests
// carrying the SAME stale account, one of them also carrying a dual-key player_id, and a curated
// person link on top. Under the old resolution all three collapsed onto one address — so a claim
// token (a bearer credential for a seat) could be delivered to a person who is not the claimant.
//
// Every function here is CALLED. A migration that applies is not evidence.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { applyPreH0, applyH0, FIXTURE_SQL, IDS } from './abc16Fixture';

let db: PGlite;

const ACCOUNT = IDS.bookedProfile;          // the stale account both guests point at
const ACCOUNT_EMAIL = 'account.holder@example.test';
const GUEST_A = '3b000000-0000-4000-8000-0000000000a1';   // own email, dual-key claim
const GUEST_B = '3b000000-0000-4000-8000-0000000000a2';   // own email, same stale account
const GUEST_NONE = '3b000000-0000-4000-8000-0000000000a3'; // NO own email
const GUEST_PERSON = '3b000000-0000-4000-8000-0000000000a4'; // reachable only via a person link
const PURE = IDS.nascentProfile;
const PURE_EMAIL = 'pure.player@example.test';

const CYCLE = '4b000000-0000-4000-8000-000000000001';
const SLOT = '5b000000-0000-4000-8000-000000000001';

const uid = async (u: string | null) =>
  db.query(`SELECT set_config('abc16.uid', $1, false)`, [u ?? '']);

beforeAll(async () => {
  db = new PGlite();
  const exec = (sql: string) => db.exec(sql);
  await applyPreH0(exec);
  await db.exec(FIXTURE_SQL);
  await applyH0(exec);

  await db.exec(`
    UPDATE public.profiles SET email = '${ACCOUNT_EMAIL}', full_name = 'Account Holder'
     WHERE id = '${ACCOUNT}';
    UPDATE public.profiles SET email = '${PURE_EMAIL}', full_name = 'Pure Player'
     WHERE id = '${PURE}';

    INSERT INTO public.guest_players (id, full_name, email, academy_profile_id, linked_profile_id) VALUES
      ('${GUEST_A}', 'Guest Alpha', 'alpha@example.test', '${IDS.attackerAcademy}', '${ACCOUNT}'),
      ('${GUEST_B}', 'Guest Beta',  'beta@example.test',  '${IDS.attackerAcademy}', '${ACCOUNT}'),
      ('${GUEST_NONE}', 'Guest NoMail', NULL, '${IDS.attackerAcademy}', '${ACCOUNT}');
    -- a guest whose ONLY route to an address is a curated person link + twin
    INSERT INTO public.guest_players (id, full_name, email, academy_profile_id, twin_of_profile_id)
      VALUES ('${GUEST_PERSON}', 'Guest Person', NULL, '${IDS.attackerAcademy}', '${ACCOUNT}');
    -- guest_players INSERT auto-mints a person link, so reuse THAT person rather than adding a
    -- second one (the unique key on guest_player_id would reject it) and curate the profile side.
    INSERT INTO public.person_links (person_id, profile_id)
      SELECT pl.person_id, '${ACCOUNT}' FROM public.person_links pl
       WHERE pl.guest_player_id = '${GUEST_PERSON}'
      ON CONFLICT DO NOTHING;

    INSERT INTO public.cycles (id, owner_type, owner_id, type, name)
      VALUES ('${CYCLE}', 'academy', '${IDS.attackerAcademy}', 'cyclus', 'Autumn');
    INSERT INTO public.availability_slots (id, academy_profile_id, cyclus_id, start_time)
      VALUES ('${SLOT}', '${IDS.attackerAcademy}', '${CYCLE}', now() + interval '5 days');

    -- claims: a dual-key guest, a guest-only, two contactless guests, and a pure profile
    INSERT INTO public.slot_priority_claims
      (slot_id, player_id, guest_player_id, status, claim_token, expires_at, reminder_sent_at) VALUES
      ('${SLOT}', '${ACCOUNT}', '${GUEST_A}',    'pending', 'tok-a',    now() + interval '6 hours', NULL),
      ('${SLOT}', NULL,         '${GUEST_B}',    'pending', 'tok-b',    now() + interval '6 hours', NULL),
      ('${SLOT}', '${ACCOUNT}', '${GUEST_NONE}', 'pending', 'tok-none', now() + interval '6 hours', NULL),
      ('${SLOT}', '${ACCOUNT}', '${GUEST_PERSON}','pending','tok-per',  now() + interval '6 hours', NULL),
      ('${SLOT}', '${PURE}',    NULL,            'pending', 'tok-pure', now() + interval '6 hours', NULL);
  `);
}, 180_000);

const contacts = async (ids: string[]) => {
  const r = await db.query<{
    guest_id: string; own_name: string | null; own_email: string | null;
    account_name: string | null; account_email: string | null; has_account: boolean;
  }>(`SELECT * FROM public.resolve_guest_member_contacts($1::uuid[])`, [ids]);
  return new Map(r.rows.map((x) => [x.guest_id, x]));
};

describe('§2 · guest_verified_account_profile is fail-closed', () => {
  it('resolves NO account for a guest reachable through every legacy route', async () => {
    for (const g of [GUEST_A, GUEST_B, GUEST_NONE, GUEST_PERSON]) {
      const r = await db.query<{ v: string | null }>(
        `SELECT public.guest_verified_account_profile($1::uuid) AS v`, [g]);
      expect(r.rows[0].v).toBeNull();
    }
  });

  it('the stored bridge values are PRESERVED — contained, not deleted', async () => {
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.guest_players
        WHERE id = ANY($1::uuid[]) AND (linked_profile_id IS NOT NULL OR twin_of_profile_id IS NOT NULL)`,
      [[GUEST_A, GUEST_B, GUEST_NONE, GUEST_PERSON]]);
    expect(r.rows[0].n).toBe(4);
    const pl = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.person_links`);
    expect(pl.rows[0].n).toBeGreaterThanOrEqual(2);
  });
});

describe('§2 · resolve_guest_member_contacts returns own attributes only', () => {
  it('a dual-key guest gets their OWN email; the accompanying account is not returned', async () => {
    const m = await contacts([GUEST_A]);
    expect(m.get(GUEST_A)!.own_email).toBe('alpha@example.test');
    expect(m.get(GUEST_A)!.account_email).toBeNull();
    expect(m.get(GUEST_A)!.has_account).toBe(false);
  });

  it('two guests sharing ONE stale account remain two distinct recipients', async () => {
    const m = await contacts([GUEST_A, GUEST_B]);
    expect(m.get(GUEST_A)!.own_email).toBe('alpha@example.test');
    expect(m.get(GUEST_B)!.own_email).toBe('beta@example.test');
    expect(new Set([m.get(GUEST_A)!.own_email, m.get(GUEST_B)!.own_email]).size).toBe(2);
  });

  it('a guest with no email of their own is UNRESOLVED — never the account address', async () => {
    const m = await contacts([GUEST_NONE, GUEST_PERSON]);
    for (const g of [GUEST_NONE, GUEST_PERSON]) {
      expect(m.get(g)!.own_email).toBeNull();
      expect(m.get(g)!.account_email).toBeNull();
      expect([m.get(g)!.own_email, m.get(g)!.account_email]).not.toContain(ACCOUNT_EMAIL);
    }
  });

  it('the result SHAPE is unchanged, so no caller breaks', async () => {
    const r = await db.query(`SELECT * FROM public.resolve_guest_member_contacts($1::uuid[])`, [[GUEST_A]]);
    expect(Object.keys(r.rows[0] as object).sort()).toEqual(
      ['account_email', 'account_name', 'guest_id', 'has_account', 'own_email', 'own_name']);
  });
});

describe('§2 · guests_have_rebook_contact', () => {
  const ask = async (u: string | null, ids: string[]) => {
    await uid(u);
    const r = await db.query<{ guest_id: string; has_contact: boolean }>(
      `SELECT * FROM public.guests_have_rebook_contact($1::uuid[])`, [ids]);
    return new Map(r.rows.map((x) => [x.guest_id, x.has_contact]));
  };

  it('POSITIVE CONTROL: a manager sees their own guests, so a denial below is not vacuous', async () => {
    const m = await ask(IDS.attackerUser, [GUEST_A, GUEST_B]);
    expect(m.get(GUEST_A)).toBe(true);
    expect(m.get(GUEST_B)).toBe(true);
  });

  it('a guest reachable ONLY through the bridge now has NO contact', async () => {
    const m = await ask(IDS.attackerUser, [GUEST_NONE, GUEST_PERSON]);
    expect(m.get(GUEST_NONE)).toBe(false);
    expect(m.get(GUEST_PERSON)).toBe(false);
  });

  it('the tenant gate survives: an outsider is answered about nobody', async () => {
    const m = await ask(IDS.victimUser, [GUEST_A, GUEST_B, GUEST_NONE]);
    expect(m.size).toBe(0);
  });

  it('the over-cap refusal survives and is loud, not a silent truncation', async () => {
    await uid(IDS.attackerUser);
    const many = Array.from({ length: 1001 }, (_, i) =>
      `3b000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    await expect(
      db.query(`SELECT * FROM public.guests_have_rebook_contact($1::uuid[])`, [many]),
    ).rejects.toThrow(/too many ids/);
  });
});

describe('§2 · rebook_claims_needing_auto_reminder', () => {
  const due = async () => {
    const r = await db.query<{
      guest_player_id: string | null; player_id: string | null;
      recipient_name: string | null; recipient_email: string | null; claim_token: string;
    }>(`SELECT * FROM public.rebook_claims_needing_auto_reminder(24)`);
    return r.rows;
  };

  it('POSITIVE CONTROL: reachable claimants are still produced', async () => {
    const rows = await due();
    const tokens = rows.map((r) => r.claim_token).sort();
    expect(tokens).toContain('tok-a');       // dual-key guest with own email
    expect(tokens).toContain('tok-b');       // guest-only
    expect(tokens).toContain('tok-pure');    // pure profile
  });

  it('a dual-key guest is addressed at their OWN name and email, never the account', async () => {
    const row = (await due()).find((r) => r.claim_token === 'tok-a')!;
    expect(row.guest_player_id).toBe(GUEST_A);
    expect(row.player_id).toBe(ACCOUNT);             // the stale column is still stored…
    expect(row.recipient_email).toBe('alpha@example.test');  // …and is not used
    expect(row.recipient_name).toBe('Guest Alpha');
    expect(row.recipient_email).not.toBe(ACCOUNT_EMAIL);
  });

  it('two guests sharing the stale account are two rows with two addresses', async () => {
    const rows = (await due()).filter((r) => ['tok-a', 'tok-b'].includes(r.claim_token));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.recipient_email)).size).toBe(2);
  });

  it('a contactless guest is produced with a NULL address — an explicit unresolved, not a reroute', async () => {
    const rows = (await due()).filter((r) => ['tok-none', 'tok-per'].includes(r.claim_token));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.recipient_email).toBeNull();
    expect((await due()).map((r) => r.recipient_email)).not.toContain(ACCOUNT_EMAIL);
  });

  it('RETAINED: a pure profile keeps its direct profile contact', async () => {
    const row = (await due()).find((r) => r.claim_token === 'tok-pure')!;
    expect(row.guest_player_id).toBeNull();
    expect(row.recipient_email).toBe(PURE_EMAIL);
    expect(row.recipient_name).toBe('Pure Player');
  });

  it('the future-slot and due-window guards survive', async () => {
    await db.exec(`UPDATE public.availability_slots SET start_time = now() - interval '1 day' WHERE id = '${SLOT}'`);
    expect(await due()).toEqual([]);
    await db.exec(`UPDATE public.availability_slots SET start_time = now() + interval '5 days' WHERE id = '${SLOT}'`);
    expect((await due()).length).toBeGreaterThan(0);
  });
});

describe('§2 · the withdrawn arms cannot come back through a body edit', () => {
  it('no §2 function reads any legacy bridge evidence', async () => {
    const r = await db.query<{ proname: string }>(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('guest_verified_account_profile','resolve_guest_member_contacts',
                           'guests_have_rebook_contact','rebook_claims_needing_auto_reminder')
         AND (p.prosrc ~ 'person_links' OR p.prosrc ~ 'twin_of_profile_id'
              OR p.prosrc ~ 'linked_profile_id')`);
    expect(r.rows).toEqual([]);
  });

  it('grants are unchanged: the resolver stays service-role only, the predicate stays manager-callable', async () => {
    const r = await db.query<{ a: boolean; b: boolean; c: boolean }>(`
      SELECT has_function_privilege('anon', 'public.resolve_guest_member_contacts(uuid[])', 'EXECUTE') AS a,
             has_function_privilege('authenticated', 'public.resolve_guest_member_contacts(uuid[])', 'EXECUTE') AS b,
             has_function_privilege('authenticated', 'public.guests_have_rebook_contact(uuid[])', 'EXECUTE') AS c`);
    expect(r.rows[0]).toEqual({ a: false, b: false, c: true });
  });
});
