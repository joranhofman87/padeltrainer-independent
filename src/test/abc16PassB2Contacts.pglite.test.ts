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

const GUEST_DECLINED = '3b000000-0000-4000-8000-0000000000a5'; // own email, said no
const GUEST_REMINDED = '3b000000-0000-4000-8000-0000000000a6'; // own email, already nudged

// One cycle per negative arm. The producer's DISTINCT ON key is (cycle, person), so putting two
// claims for the same claimant in one cycle would collapse them and a negative arm could "pass"
// because its row lost a tiebreak rather than because the guard excluded it.
const CYCLE = '4b000000-0000-4000-8000-000000000001';           // the due world
const CYCLE_PAST = '4b000000-0000-4000-8000-000000000002';      // session already happened
const CYCLE_CLOSED = '4b000000-0000-4000-8000-000000000003';    // priority window already shut
const CYCLE_FAR = '4b000000-0000-4000-8000-000000000004';       // window opens beyond the lead
const CYCLE_BEYOND = '4b000000-0000-4000-8000-000000000009';    // window beyond the 336h ceiling
const CYCLE_CLAIMED = '4b000000-0000-4000-8000-00000000000a';   // claim no longer pending
const CYCLE_OPTOUT = '4b000000-0000-4000-8000-000000000005';    // rebook_auto_reminder = false
const CYCLE_JUNKLEAD = '4b000000-0000-4000-8000-000000000006';  // unparseable lead override
const CYCLE_SHORTLEAD = '4b000000-0000-4000-8000-000000000007'; // valid, honoured lead override
const CYCLE_PLAIN = '4b000000-0000-4000-8000-000000000008';     // not a rebook round at all

const SLOT = '5b000000-0000-4000-8000-000000000001';
const SLOT_PAST = '5b000000-0000-4000-8000-000000000002';
const SLOT_CLOSED = '5b000000-0000-4000-8000-000000000003';
const SLOT_FAR = '5b000000-0000-4000-8000-000000000004';
const SLOT_OPTOUT = '5b000000-0000-4000-8000-000000000005';
const SLOT_JUNKLEAD = '5b000000-0000-4000-8000-000000000006';
const SLOT_SHORTLEAD = '5b000000-0000-4000-8000-000000000007';
const SLOT_PLAIN = '5b000000-0000-4000-8000-000000000008';
const SLOT_BEYOND = '5b000000-0000-4000-8000-000000000009';
const SLOT_CLAIMED = '5b000000-0000-4000-8000-00000000000a';

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
      ('${GUEST_NONE}', 'Guest NoMail', NULL, '${IDS.attackerAcademy}', '${ACCOUNT}'),
      ('${GUEST_DECLINED}', 'Guest Declined', 'declined@example.test', '${IDS.attackerAcademy}', '${ACCOUNT}'),
      ('${GUEST_REMINDED}', 'Guest Reminded', 'reminded@example.test', '${IDS.attackerAcademy}', '${ACCOUNT}');
    -- a guest whose ONLY route to an address is a curated person link + twin
    INSERT INTO public.guest_players (id, full_name, email, academy_profile_id, twin_of_profile_id)
      VALUES ('${GUEST_PERSON}', 'Guest Person', NULL, '${IDS.attackerAcademy}', '${ACCOUNT}');
    -- guest_players INSERT auto-mints a person link, so reuse THAT person rather than adding a
    -- second one (the unique key on guest_player_id would reject it) and curate the profile side.
    INSERT INTO public.person_links (person_id, profile_id)
      SELECT pl.person_id, '${ACCOUNT}' FROM public.person_links pl
       WHERE pl.guest_player_id = '${GUEST_PERSON}'
      ON CONFLICT DO NOTHING;

    -- A rebook round is a cycle whose settings carry rebook_payment_mode; rebook_auto_reminder
    -- defaults ON and rebook_reminder_lead_hours overrides the caller's lead. All three are the
    -- shipped 20260930100000 vocabulary, reproduced here rather than invented.
    INSERT INTO public.cycles (id, owner_type, owner_id, type, name, settings) VALUES
      ('${CYCLE}',           'academy', '${IDS.attackerAcademy}', 'cyclus', 'Autumn',
        '{"rebook_payment_mode":"per_player"}'::jsonb),
      ('${CYCLE_PAST}',      'academy', '${IDS.attackerAcademy}', 'cyclus', 'PastSession',
        '{"rebook_payment_mode":"per_player"}'::jsonb),
      ('${CYCLE_CLOSED}',    'academy', '${IDS.attackerAcademy}', 'cyclus', 'WindowShut',
        '{"rebook_payment_mode":"per_player"}'::jsonb),
      ('${CYCLE_FAR}',       'academy', '${IDS.attackerAcademy}', 'cyclus', 'FarOff',
        '{"rebook_payment_mode":"per_player"}'::jsonb),
      ('${CYCLE_OPTOUT}',    'academy', '${IDS.attackerAcademy}', 'cyclus', 'OptedOut',
        '{"rebook_payment_mode":"per_player","rebook_auto_reminder":false}'::jsonb),
      ('${CYCLE_JUNKLEAD}',  'academy', '${IDS.attackerAcademy}', 'cyclus', 'JunkLead',
        '{"rebook_payment_mode":"per_player","rebook_reminder_lead_hours":"soon-ish"}'::jsonb),
      ('${CYCLE_SHORTLEAD}', 'academy', '${IDS.attackerAcademy}', 'cyclus', 'ShortLead',
        '{"rebook_payment_mode":"per_player","rebook_reminder_lead_hours":"2"}'::jsonb),
      ('${CYCLE_PLAIN}',     'academy', '${IDS.attackerAcademy}', 'cyclus', 'NotARebookRound',
        '{}'::jsonb),
      ('${CYCLE_BEYOND}',    'academy', '${IDS.attackerAcademy}', 'cyclus', 'BeyondCeiling',
        '{"rebook_payment_mode":"per_player"}'::jsonb),
      ('${CYCLE_CLAIMED}',   'academy', '${IDS.attackerAcademy}', 'cyclus', 'AlreadyClaimed',
        '{"rebook_payment_mode":"per_player"}'::jsonb);

    INSERT INTO public.availability_slots
      (id, academy_profile_id, cyclus_id, start_time, priority_window_ends_at) VALUES
      ('${SLOT}',           '${IDS.attackerAcademy}', '${CYCLE}',
        now() + interval '5 days',  now() + interval '6 hours'),
      -- the SESSION is in the past although its window is still open (the malformed-deadline
      -- anomaly 20260930100000 was written to defend against)
      ('${SLOT_PAST}',      '${IDS.attackerAcademy}', '${CYCLE_PAST}',
        now() - interval '1 day',   now() + interval '6 hours'),
      ('${SLOT_CLOSED}',    '${IDS.attackerAcademy}', '${CYCLE_CLOSED}',
        now() + interval '5 days',  now() - interval '1 hour'),
      -- open, but further out than the default lead — and inside the 336h ceiling, so a wider
      -- lead must reach it. Both directions are asserted; a one-sided arm could not tell "the
      -- lead bound excluded it" from "something else did".
      ('${SLOT_FAR}',       '${IDS.attackerAcademy}', '${CYCLE_FAR}',
        now() + interval '60 days', now() + interval '10 days'),
      ('${SLOT_OPTOUT}',    '${IDS.attackerAcademy}', '${CYCLE_OPTOUT}',
        now() + interval '5 days',  now() + interval '6 hours'),
      ('${SLOT_JUNKLEAD}',  '${IDS.attackerAcademy}', '${CYCLE_JUNKLEAD}',
        now() + interval '5 days',  now() + interval '6 hours'),
      ('${SLOT_SHORTLEAD}', '${IDS.attackerAcademy}', '${CYCLE_SHORTLEAD}',
        now() + interval '5 days',  now() + interval '6 hours'),
      ('${SLOT_PLAIN}',     '${IDS.attackerAcademy}', '${CYCLE_PLAIN}',
        now() + interval '5 days',  now() + interval '6 hours'),
      -- 30 days out: PAST the 336h (14-day) ceiling, so no caller lead may ever reach it. This is
      -- what makes the clamp itself testable — SLOT_FAR alone only proves the lead bound moves.
      ('${SLOT_BEYOND}',    '${IDS.attackerAcademy}', '${CYCLE_BEYOND}',
        now() + interval '60 days', now() + interval '30 days'),
      ('${SLOT_CLAIMED}',   '${IDS.attackerAcademy}', '${CYCLE_CLAIMED}',
        now() + interval '5 days',  now() + interval '6 hours');

    -- claims: a dual-key guest, a guest-only, two contactless guests, a pure profile, one who
    -- declined and one already reminded — then one claimant per negative-arm cycle.
    INSERT INTO public.slot_priority_claims
      (slot_id, player_id, guest_player_id, status, claim_token, response_intent, reminded_at) VALUES
      ('${SLOT}', '${ACCOUNT}', '${GUEST_A}',        'pending', 'tok-a',        NULL,      NULL),
      ('${SLOT}', NULL,         '${GUEST_B}',        'pending', 'tok-b',        'accept',  NULL),
      ('${SLOT}', '${ACCOUNT}', '${GUEST_NONE}',     'pending', 'tok-none',     NULL,      NULL),
      ('${SLOT}', '${ACCOUNT}', '${GUEST_PERSON}',   'pending', 'tok-per',      NULL,      NULL),
      ('${SLOT}', '${PURE}',    NULL,                'pending', 'tok-pure',     NULL,      NULL),
      ('${SLOT}', '${ACCOUNT}', '${GUEST_DECLINED}', 'pending', 'tok-declined', 'decline', NULL),
      ('${SLOT}', '${ACCOUNT}', '${GUEST_REMINDED}', 'pending', 'tok-reminded', NULL,      now()),
      -- A claim that is no longer open at all. It lives in its OWN cycle deliberately: sharing
      -- CYCLE with tok-a would give both rows the same (cycle, person) DISTINCT ON key, so
      -- dropping the status predicate could still let tok-a win the tiebreak and the control
      -- would stay green while the guard it names was gone.
      ('${SLOT_CLAIMED}',   '${ACCOUNT}', '${GUEST_A}', 'claimed', 'tok-claimed',   NULL, NULL),
      ('${SLOT_BEYOND}',    '${ACCOUNT}', '${GUEST_A}', 'pending', 'tok-beyond',    NULL, NULL),
      ('${SLOT_PAST}',      '${ACCOUNT}', '${GUEST_A}', 'pending', 'tok-past',      NULL, NULL),
      ('${SLOT_CLOSED}',    '${ACCOUNT}', '${GUEST_A}', 'pending', 'tok-closed',    NULL, NULL),
      ('${SLOT_FAR}',       '${ACCOUNT}', '${GUEST_A}', 'pending', 'tok-far',       NULL, NULL),
      ('${SLOT_OPTOUT}',    '${ACCOUNT}', '${GUEST_A}', 'pending', 'tok-optout',    NULL, NULL),
      ('${SLOT_JUNKLEAD}',  '${ACCOUNT}', '${GUEST_A}', 'pending', 'tok-junklead',  NULL, NULL),
      ('${SLOT_SHORTLEAD}', '${ACCOUNT}', '${GUEST_A}', 'pending', 'tok-shortlead', NULL, NULL),
      ('${SLOT_PLAIN}',     '${ACCOUNT}', '${GUEST_A}', 'pending', 'tok-plain',     NULL, NULL);
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

  it('…and it is a FLOOR, not a band: a far larger call is refused too', async () => {
    // A guard written as `> 1000 AND cardinality(...) < 2000` passes the 1001-element control
    // above while letting a 3000-element call through unrefused. Only a second, much larger arm
    // can tell the two apart.
    await uid(IDS.attackerUser);
    const far = Array.from({ length: 3000 }, (_, i) =>
      `3b000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    await expect(
      db.query(`SELECT * FROM public.guests_have_rebook_contact($1::uuid[])`, [far]),
    ).rejects.toThrow(/too many ids/);
  });

  it('a PLATFORM ADMINISTRATOR is answered about nobody either — membership is the ONLY key', async () => {
    // A LIVE subject, not a structural claim. `is_admin` is constant-false in this fixture, but
    // the repo's other canonical admin authority — has_role → abc16_admins — is modelled for
    // real, so an actual administrator can be created here. That is what discriminates an added
    // early-return admin arm (one that leaves the manager CTE intact and never mentions
    // `is_admin`) from the shipped membership-only gate: managing no academy must mean being
    // answered about nobody, administrator or not.
    await db.query(`INSERT INTO public.abc16_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [IDS.victimUser]);
    try {
      const check = await db.query<{ ok: boolean }>(
        `SELECT public.has_role($1::uuid, 'admin') AS ok`, [IDS.victimUser]);
      expect(check.rows[0].ok).toBe(true);           // the subject really is an administrator…
      const m = await ask(IDS.victimUser, [GUEST_A, GUEST_B, GUEST_NONE]);
      expect(m.size).toBe(0);                        // …and is still told nothing
    } finally {
      await db.query(`DELETE FROM public.abc16_admins WHERE user_id = $1`, [IDS.victimUser]);
    }
  });

  it('…and the body names no admin predicate at all', async () => {
    // Belt to the live arm's braces, case-insensitive: an unquoted SQL identifier is
    // case-insensitive, so `IS_ADMIN` names exactly the same function as `is_admin`.
    const r = await db.query<{ src: string }>(`
      SELECT p.prosrc AS src FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.guests_have_rebook_contact(uuid[])')`);
    expect(r.rows[0].src).not.toMatch(/is_admin/i);
    expect(r.rows[0].src).not.toMatch(/has_role/i);
    expect(r.rows[0].src).toMatch(
      /JOIN public\.academy_managers am ON am\.academy_profile_id = c\.owner_id AND am\.user_id = auth\.uid\(\)\s+WHERE spc\.guest_player_id = ANY\(_guest_ids\)\s*\)/);
  });
});

describe('§2 · rebook_claims_needing_auto_reminder', () => {
  const due = async (lead = 24) => {
    const r = await db.query<{
      guest_player_id: string | null; player_id: string | null;
      recipient_name: string | null; recipient_email: string | null; claim_token: string;
    }>(`SELECT * FROM public.rebook_claims_needing_auto_reminder($1::int)`, [lead]);
    return r.rows;
  };
  const tokens = async (lead = 24) => (await due(lead)).map((r) => r.claim_token);

  it('POSITIVE CONTROL: reachable claimants are still produced', async () => {
    const t = await tokens();
    expect(t).toContain('tok-a');       // dual-key guest with own email
    expect(t).toContain('tok-b');       // guest-only
    expect(t).toContain('tok-pure');    // pure profile
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

  it('RETAINED: a pure profile keeps its direct profile contact', async () => {
    const row = (await due()).find((r) => r.claim_token === 'tok-pure')!;
    expect(row.guest_player_id).toBeNull();
    expect(row.recipient_email).toBe(PURE_EMAIL);
    expect(row.recipient_name).toBe('Pure Player');
  });

  it('WITHDRAWN: a contactless guest is DROPPED, never addressed at the account', async () => {
    // The verified-account fallback is what used to make these two reachable. With it withdrawn
    // they have no address of their own, so the shipped deliverable-address guard drops them
    // rather than handing the mailer a NULL recipient or, worse, the account's address.
    const t = await tokens();
    expect(t).not.toContain('tok-none');
    expect(t).not.toContain('tok-per');
    expect((await due()).map((r) => r.recipient_email)).not.toContain(ACCOUNT_EMAIL);
  });

  it('every produced row carries a deliverable address', async () => {
    for (const r of await due()) expect(r.recipient_email).toBeTruthy();
  });

  describe('the shipped due window is intact', () => {
    it('a claimant who DECLINED is not chased', async () => {
      expect(await tokens()).not.toContain('tok-declined');
    });

    it('a claimant ALREADY reminded is not chased again', async () => {
      expect(await tokens()).not.toContain('tok-reminded');
    });

    it('a claim that is no longer pending is not chased', async () => {
      expect(await tokens()).not.toContain('tok-claimed');
    });

    it('a PAST session never qualifies, even with an open window', async () => {
      expect(await tokens()).not.toContain('tok-past');
    });

    it('a CLOSED priority window does not qualify', async () => {
      expect(await tokens()).not.toContain('tok-closed');
    });

    it('a window beyond the lead does not qualify — but does once the lead reaches it', async () => {
      // The window is 10 days out. A 24h lead misses it; widening to the 336h (14-day) ceiling
      // reaches it. The pair is what proves the LEAD bound is doing the excluding.
      expect(await tokens(24)).not.toContain('tok-far');
      expect(await tokens(336)).toContain('tok-far');
    });

    it('the lead is clamped, so an absurd caller value cannot widen the sweep without bound', async () => {
      // 100000h is ~11 years. LEAST(336, …) holds the lead at 14 days, so a window 30 days out
      // must STAY excluded no matter what the caller asks for. The pair is what makes the clamp
      // itself the thing under test: tok-far (10 days) is inside the ceiling and comes in, while
      // tok-beyond (30 days) is outside it and cannot — delete the LEAST and tok-beyond appears.
      const t = await tokens(100000);
      expect(t).toContain('tok-far');        // 10 days ≤ the 14-day ceiling
      expect(t).not.toContain('tok-beyond'); // 30 days > the ceiling, at any caller lead
    });

    it('a per-round OPT-OUT suppresses the round', async () => {
      expect(await tokens()).not.toContain('tok-optout');
    });

    it('a cycle that is not a rebook round is never swept', async () => {
      expect(await tokens()).not.toContain('tok-plain');
    });

    it('a VALID per-round lead override is honoured over the caller\'s', async () => {
      // window is 6h out; the round overrides the lead to 2h, so 6h > 2h ⇒ not yet due, even
      // though the caller asked for 24h. Without the override this row would be produced.
      expect(await tokens(24)).not.toContain('tok-shortlead');
    });

    it('an UNPARSEABLE lead override falls back instead of erroring the cron', async () => {
      // 'soon-ish' is junk. The digits-only parse must yield NULL and COALESCE to the caller's
      // 24h, which the 6h window is inside — so the row IS produced. A body that let junk
      // through would raise and take the whole cron down with it.
      expect(await tokens(24)).toContain('tok-junklead');
    });

    it('the window is evaluated against app_now(), not now()', async () => {
      // Move the test clock past the priority window without touching a single row. Only a
      // producer that reads the clock function sees this.
      await db.query(`SELECT set_config('app.fake_now', $1, false)`,
        [new Date(Date.now() + 48 * 3600_000).toISOString()]);
      try {
        expect(await tokens()).not.toContain('tok-a');
      } finally {
        await db.query(`SELECT set_config('app.fake_now', '', false)`);
      }
      expect(await tokens()).toContain('tok-a');   // and the clock reset restores it
    });
  });

  it('the producer names NO unsourced claim column', async () => {
    // expires_at and reminder_sent_at have no migration anywhere in this repository and no
    // writer anywhere in the product. A body grounded on them parses only where a database
    // carries them out of band, and even there returns nothing forever.
    const r = await db.query<{ src: string }>(`
      SELECT p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'rebook_claims_needing_auto_reminder'`);
    expect(r.rows[0].src).not.toMatch(/\bexpires_at\b/);
    expect(r.rows[0].src).not.toMatch(/\breminder_sent_at\b/);
    expect(r.rows[0].src).toContain('priority_window_ends_at');
    expect(r.rows[0].src).toContain('app_now');
  });

  it('and the fixture does not fabricate them either', async () => {
    const r = await db.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'slot_priority_claims'
         AND column_name IN ('expires_at', 'reminder_sent_at')`);
    expect(r.rows[0].n).toBe(0);
  });

  it('ACL: the producer stays service_role only — it returns claim tokens cross-academy', async () => {
    const r = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(`
      SELECT has_function_privilege('anon',          'public.rebook_claims_needing_auto_reminder(int)', 'EXECUTE') AS anon,
             has_function_privilege('authenticated', 'public.rebook_claims_needing_auto_reminder(int)', 'EXECUTE') AS auth,
             has_function_privilege('service_role',  'public.rebook_claims_needing_auto_reminder(int)', 'EXECUTE') AS svc`);
    expect(r.rows[0]).toEqual({ anon: false, auth: false, svc: true });
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
