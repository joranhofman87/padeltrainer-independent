// @vitest-environment node
// PR 10d — FAM-02 guest-first identity across the rebook reminder SQL, proven end-to-end against
// real Postgres (PGlite) with the REAL migration 20260927100000. The scenario is the bug's core:
// a PARENT (pure profile) and their linked CHILD (a guest whose claim ALSO carries the parent's
// player_id as legacy link decoration) both hold pending claims in the same cycle. Player-first
// keying collapsed them and cross-stamped their claims; guest-first keeps them two distinct people.
//
// This file is the CROSS-LAYER proof the review asked for: it starts from raw claims (before any
// grouping), runs the detection RPC (which groups), routes each candidate exactly as the cron
// sender does (guest-first), calls bump_rebook_reminders, and asserts the FINAL stamped rows — so
// no unit test can pass around an already-collapsed input.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACAD = 'a0000000-0000-0000-0000-0000000000a0';
const CYCLE = 'c0000000-0000-0000-0000-0000000000c1';
const S1 = '50000000-0000-0000-0000-000000000001';
const S2 = '50000000-0000-0000-0000-000000000002';
const PARENT = 'aa000000-0000-0000-0000-0000000000a1'; // pure profile, own claim
const CHILD = 'bb000000-0000-0000-0000-0000000000b1';  // dual-key guest WITH own email
const CHILD2 = 'bb000000-0000-0000-0000-0000000000b2'; // dual-key guest with NO own email (linked fallback)
const CL_P = 'c1a00000-0000-0000-0000-000000000001';   // PARENT's own claim (player_id=PARENT, guest NULL)
const CL_C = 'c1b00000-0000-0000-0000-000000000001';   // CHILD's dual-key claim (player_id=PARENT, guest=CHILD)
const CL_C2 = 'c1c00000-0000-0000-0000-000000000001';  // CHILD2's dual-key claim (player_id=PARENT, guest=CHILD2)

type Cand = { player_id: string | null; guest_player_id: string | null; recipient_email: string; recipient_name: string };
const candidates = async (): Promise<Cand[]> =>
  (await db.query<Cand>(`SELECT player_id, guest_player_id, recipient_email, recipient_name
                         FROM public.rebook_claims_needing_auto_reminder(24)`)).rows;

const remindedOf = async (claimId: string): Promise<{ reminded: boolean; count: number }> => {
  const r = (await db.query<{ reminded_at: string | null; reminder_count: number }>(
    `SELECT reminded_at, reminder_count FROM public.slot_priority_claims WHERE id = $1`, [claimId])).rows[0];
  return { reminded: r.reminded_at !== null, count: r.reminder_count };
};

// Route a candidate exactly as the cron/manual sender does after PR 10d: guest-first (a dual-key
// row goes to p_guest_ids, never p_player_ids), then stamp via the shared RPC.
const stampViaRouting = async (cands: Cand[], slotIds: string[]) => {
  const players: string[] = [];
  const guests: string[] = [];
  for (const c of cands) {
    if (c.guest_player_id) guests.push(c.guest_player_id); // personRefOf: guest wins on a dual-key row
    else if (c.player_id) players.push(c.player_id);
  }
  await db.query(`SELECT public.bump_rebook_reminders($1::uuid[], $2::uuid[], $3::uuid[])`, [slotIds, players, guests]);
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;

    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text, email text);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, full_name text, email text, linked_profile_id uuid, twin_of_profile_id uuid, split_frozen boolean DEFAULT false);
    CREATE TABLE public.persons (id uuid PRIMARY KEY);
    CREATE TABLE public.person_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid, profile_id uuid, guest_player_id uuid);
    CREATE TABLE public.rate_limits (identifier text, endpoint text, request_count int, window_start timestamptz, UNIQUE(identifier, endpoint));
    CREATE TABLE public.academy_managers (academy_profile_id uuid, user_id uuid);
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $auth$
      SELECT NULLIF(current_setting('test.uid', true), '')::uuid $auth$;
    CREATE FUNCTION public.is_guest_split_frozen(_guest_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $frz$
      SELECT COALESCE((SELECT split_frozen FROM public.guest_players WHERE id = _guest_id), false) $frz$;
    CREATE TABLE public.cycles (id uuid PRIMARY KEY, name text, owner_type text, owner_id uuid, settings jsonb);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, cyclus_id uuid, priority_window_ends_at timestamptz);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY, slot_id uuid, player_id uuid, guest_player_id uuid,
      status text, response_intent text, reminded_at timestamptz, reminder_count int NOT NULL DEFAULT 0,
      claim_token text DEFAULT gen_random_uuid()::text);

    -- app_now() (real one lives in 20260724100000): fake clock via GUC, else now().
    CREATE OR REPLACE FUNCTION public.app_now() RETURNS timestamptz LANGUAGE sql STABLE AS $fn$
      SELECT COALESCE(NULLIF(current_setting('app.fake_now', true), '')::timestamptz, now())
    $fn$;

    -- The member-open cron trio (real defs live in 20260714110000 / 20260817100000). Stubbed here
    -- with the SAME signatures so the migration's grant lockdown applies + can be pinned. A fresh
    -- function is PUBLIC-executable by default, so anon/authenticated start able to run it — exactly
    -- the leak the migration closes.
    CREATE FUNCTION public.rebook_cycles_needing_member_open_notice() RETURNS TABLE(cycle_id uuid)
      LANGUAGE sql SECURITY DEFINER AS $fn$ SELECT NULL::uuid WHERE false $fn$;
    CREATE FUNCTION public.claim_rebook_member_open_notice(_cycle_id uuid) RETURNS boolean
      LANGUAGE sql SECURITY DEFINER AS $fn$ SELECT true $fn$;
    CREATE FUNCTION public.unclaim_rebook_member_open_notice(_cycle_id uuid) RETURNS void
      LANGUAGE sql SECURITY DEFINER AS $fn$ SELECT $fn$;

    INSERT INTO public.academy_profiles VALUES ('${ACAD}', 'RL Padel');
    INSERT INTO public.profiles (id, full_name, email) VALUES ('${PARENT}', 'Parent', 'parent@example.com');
    INSERT INTO public.guest_players (id, full_name, email, linked_profile_id) VALUES
      ('${CHILD}',  'Child',  'child@example.com', '${PARENT}'),
      ('${CHILD2}', 'Child2', NULL,               '${PARENT}');   -- no own email → linked-profile fallback

    INSERT INTO public.cycles (id, name, owner_type, owner_id, settings) VALUES
      ('${CYCLE}', 'Ronde', 'academy', '${ACAD}', '{"rebook_payment_mode":"upfront"}');
    INSERT INTO public.availability_slots (id, cyclus_id, priority_window_ends_at) VALUES
      ('${S1}', '${CYCLE}', now() + interval '12 hours'),
      ('${S2}', '${CYCLE}', now() + interval '12 hours');

    -- The collision: PARENT's own claim and CHILD's dual-key claim BOTH carry player_id=PARENT.
    INSERT INTO public.slot_priority_claims (id, slot_id, player_id, guest_player_id, status) VALUES
      ('${CL_P}',  '${S1}', '${PARENT}', NULL,       'pending'),   -- parent, pure profile
      ('${CL_C}',  '${S1}', '${PARENT}', '${CHILD}', 'pending'),   -- child, dual-key (own email)
      ('${CL_C2}', '${S2}', '${PARENT}', '${CHILD2}','pending');   -- child2, dual-key (no own email)
  `);
  // The REAL PR 10d migration under test (guest-first RPC + guarded bump_rebook_reminders).
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260927100000_rebook_identity_guest_first.sql'), 'utf8'));
});

beforeEach(async () => {
  await db.query(`UPDATE public.slot_priority_claims SET reminded_at = NULL, reminder_count = 0`);
});

describe('PR 10d — rebook identity guest-first (cross-layer)', () => {
  it('proof #2/#4: the detection RPC keeps PARENT and dual-key CHILD as TWO representatives (not collapsed)', async () => {
    const c = await candidates();
    const keys = c.map((x) => (x.guest_player_id ? `g:${x.guest_player_id}` : `p:${x.player_id}`)).sort();
    // parent + both children — three distinct people, never merged under the shared player_id.
    expect(keys).toEqual([`g:${CHILD}`, `g:${CHILD2}`, `p:${PARENT}`].sort());
  });

  it('proof #6: guest email + name win for a dual-key child; the linked profile is used only when the guest has none', async () => {
    const c = await candidates();
    const parent = c.find((x) => x.player_id === PARENT && !x.guest_player_id)!;
    const child = c.find((x) => x.guest_player_id === CHILD)!;
    const child2 = c.find((x) => x.guest_player_id === CHILD2)!;
    // child WITH own email → mailed at the child, named as the child (never the parent)
    expect(child.recipient_email).toBe('child@example.com');
    expect(child.recipient_name).toBe('Child');
    // child WITHOUT own email → linked profile email fallback, still the child's name
    expect(child2.recipient_email).toBe('parent@example.com');
    expect(child2.recipient_name).toBe('Child2');
    // pure profile unchanged
    expect(parent.recipient_email).toBe('parent@example.com');
    expect(parent.recipient_name).toBe('Parent');
  });

  it('proof #5: stamping the PARENT never stamps a dual-key child sharing that player_id', async () => {
    await db.query(`SELECT public.bump_rebook_reminders($1::uuid[], $2::uuid[], $3::uuid[])`,
      [[S1, S2], [PARENT], []]);
    expect((await remindedOf(CL_P)).reminded).toBe(true);   // the parent's own claim
    expect((await remindedOf(CL_C)).reminded).toBe(false);  // NOT the child's dual-key claim
    expect((await remindedOf(CL_C2)).reminded).toBe(false);
  });

  it('proof #5 (inverse): stamping a CHILD never stamps the parent or a sibling', async () => {
    await db.query(`SELECT public.bump_rebook_reminders($1::uuid[], $2::uuid[], $3::uuid[])`,
      [[S1, S2], [], [CHILD]]);
    expect((await remindedOf(CL_C)).reminded).toBe(true);   // the child's claim
    expect((await remindedOf(CL_P)).reminded).toBe(false);  // NOT the parent's own claim
    expect((await remindedOf(CL_C2)).reminded).toBe(false); // NOT the sibling
  });

  it('proof #10 (CROSS-LAYER): raw claims → RPC grouping → guest-first routing → stamp reaches exactly the child', async () => {
    // Start from raw claims (reminded_at NULL). Group via the RPC, then route ONLY the child
    // candidate through the real sender path and stamp. The parent + sibling must stay unstamped —
    // proving the whole chain keeps distinct people apart, not just the unit helpers.
    const child = (await candidates()).filter((x) => x.guest_player_id === CHILD);
    await stampViaRouting(child, [S1, S2]);
    expect((await remindedOf(CL_C)).reminded).toBe(true);
    expect((await remindedOf(CL_P)).reminded).toBe(false);
    expect((await remindedOf(CL_C2)).reminded).toBe(false);
  });

  it('proof #10 (CROSS-LAYER): routing ALL candidates stamps every person exactly once, no cross-contamination', async () => {
    const all = await candidates();
    await stampViaRouting(all, [S1, S2]);
    for (const cl of [CL_P, CL_C, CL_C2]) {
      const { reminded, count } = await remindedOf(cl);
      expect(reminded).toBe(true);
      expect(count).toBe(1); // stamped once — never double via a colliding player_id
    }
  });

  it('proof #9: every SECURITY DEFINER rebook RPC is locked to service_role (anon/authenticated cannot execute)', async () => {
    const r = (await db.query<{ chk: string; v: boolean }>(`
      SELECT 'anon' AS chk, has_function_privilege('anon','public.rebook_claims_needing_auto_reminder(int)','execute') AS v
      UNION ALL SELECT 'authenticated', has_function_privilege('authenticated','public.rebook_claims_needing_auto_reminder(int)','execute')
      UNION ALL SELECT 'service_role',  has_function_privilege('service_role','public.rebook_claims_needing_auto_reminder(int)','execute')
      UNION ALL SELECT 'bump_anon',     has_function_privilege('anon','public.bump_rebook_reminders(uuid[],uuid[],uuid[])','execute')
      UNION ALL SELECT 'bump_service',  has_function_privilege('service_role','public.bump_rebook_reminders(uuid[],uuid[],uuid[])','execute')
      -- the member-open cron trio (same footgun, now closed)
      UNION ALL SELECT 'cycles_anon',   has_function_privilege('anon','public.rebook_cycles_needing_member_open_notice()','execute')
      UNION ALL SELECT 'cycles_auth',   has_function_privilege('authenticated','public.rebook_cycles_needing_member_open_notice()','execute')
      UNION ALL SELECT 'cycles_svc',    has_function_privilege('service_role','public.rebook_cycles_needing_member_open_notice()','execute')
      UNION ALL SELECT 'claim_anon',    has_function_privilege('anon','public.claim_rebook_member_open_notice(uuid)','execute')
      UNION ALL SELECT 'claim_auth',    has_function_privilege('authenticated','public.claim_rebook_member_open_notice(uuid)','execute')
      UNION ALL SELECT 'claim_svc',     has_function_privilege('service_role','public.claim_rebook_member_open_notice(uuid)','execute')
      UNION ALL SELECT 'unclaim_anon',  has_function_privilege('anon','public.unclaim_rebook_member_open_notice(uuid)','execute')
      UNION ALL SELECT 'unclaim_auth',  has_function_privilege('authenticated','public.unclaim_rebook_member_open_notice(uuid)','execute')
      UNION ALL SELECT 'unclaim_svc',   has_function_privilege('service_role','public.unclaim_rebook_member_open_notice(uuid)','execute')
      UNION ALL SELECT 'bump_auth',     has_function_privilege('authenticated','public.bump_rebook_reminders(uuid[],uuid[],uuid[])','execute')
      UNION ALL SELECT 'append_anon',   has_function_privilege('anon','public.append_rebook_member_open_notified(uuid,text[])','execute')
      UNION ALL SELECT 'append_auth',   has_function_privilege('authenticated','public.append_rebook_member_open_notified(uuid,text[])','execute')
      UNION ALL SELECT 'append_svc',    has_function_privilege('service_role','public.append_rebook_member_open_notified(uuid,text[])','execute')
      UNION ALL SELECT 'resolve_anon',  has_function_privilege('anon','public.resolve_guest_member_contacts(uuid[])','execute')
      UNION ALL SELECT 'resolve_auth',  has_function_privilege('authenticated','public.resolve_guest_member_contacts(uuid[])','execute')
      UNION ALL SELECT 'resolve_svc',   has_function_privilege('service_role','public.resolve_guest_member_contacts(uuid[])','execute')
      UNION ALL SELECT 'gvap_anon',     has_function_privilege('anon','public.guest_verified_account_profile(uuid)','execute')
      UNION ALL SELECT 'gvap_auth',     has_function_privilege('authenticated','public.guest_verified_account_profile(uuid)','execute')
      UNION ALL SELECT 'gvap_svc',      has_function_privilege('service_role','public.guest_verified_account_profile(uuid)','execute')
      UNION ALL SELECT 'ratelimit_anon',has_function_privilege('anon','public.consume_rate_limit(text,text,int,int)','execute')
      UNION ALL SELECT 'ratelimit_auth',has_function_privilege('authenticated','public.consume_rate_limit(text,text,int,int)','execute')
      UNION ALL SELECT 'ratelimit_svc', has_function_privilege('service_role','public.consume_rate_limit(text,text,int,int)','execute')
      -- guests_have_rebook_contact is authenticated-callable BUT academy-scoped inside its body (proven above)
      UNION ALL SELECT 'ghrc_anon',     has_function_privilege('anon','public.guests_have_rebook_contact(uuid[])','execute')
      UNION ALL SELECT 'ghrc_auth',     has_function_privilege('authenticated','public.guests_have_rebook_contact(uuid[])','execute')
      UNION ALL SELECT 'ghrc_svc',      has_function_privilege('service_role','public.guests_have_rebook_contact(uuid[])','execute')
    `)).rows;
    const by = Object.fromEntries(r.map((x) => [x.chk, x.v]));
    expect(by.anon).toBe(false);          // the cross-academy email/token leak is closed
    expect(by.authenticated).toBe(false);
    expect(by.service_role).toBe(true);
    expect(by.bump_anon).toBe(false);
    expect(by.bump_service).toBe(true);
    // member-open trio: anon/authenticated locked out, service_role allowed
    expect(by.cycles_anon).toBe(false);
    expect(by.cycles_auth).toBe(false);
    expect(by.cycles_svc).toBe(true);
    expect(by.claim_anon).toBe(false);
    expect(by.claim_auth).toBe(false);
    expect(by.claim_svc).toBe(true);
    expect(by.unclaim_anon).toBe(false);
    expect(by.unclaim_auth).toBe(false);
    expect(by.unclaim_svc).toBe(true);
    expect(by.bump_auth).toBe(false);
    // new PR 10d service-role RPCs
    expect(by.append_anon).toBe(false);
    expect(by.append_auth).toBe(false);
    expect(by.append_svc).toBe(true);
    expect(by.resolve_anon).toBe(false);
    expect(by.resolve_auth).toBe(false);
    expect(by.resolve_svc).toBe(true);
    expect(by.gvap_anon).toBe(false);
    expect(by.gvap_auth).toBe(false);
    expect(by.gvap_svc).toBe(true);
    expect(by.ratelimit_anon).toBe(false);
    expect(by.ratelimit_auth).toBe(false);
    expect(by.ratelimit_svc).toBe(true);
    expect(by.ghrc_anon).toBe(false);       // anon locked out
    expect(by.ghrc_auth).toBe(true);        // authenticated managers, but academy-scoped in-body
    expect(by.ghrc_svc).toBe(true);
  });

  it('append_rebook_member_open_notified is ATOMIC + dedup (one UPDATE, no whole-settings clobber)', async () => {
    const CY = 'c0000000-0000-0000-0000-0000000000d1';
    await db.exec(`INSERT INTO public.cycles (id, name, owner_type, owner_id, settings) VALUES ('${CY}','Chk','academy','${ACAD}','{"other":"keep"}')`);
    // append two keys, then re-append one of them + a new one — must dedup and PRESERVE other settings.
    await db.query(`SELECT public.append_rebook_member_open_notified($1, $2::text[])`, [CY, ['g:a', 'p:b']]);
    await db.query(`SELECT public.append_rebook_member_open_notified($1, $2::text[])`, [CY, ['g:a', 'p:c']]);
    const row = (await db.query<{ settings: { rebook_member_open_notified_recipients: string[]; other: string } }>(
      `SELECT settings FROM public.cycles WHERE id = '${CY}'`)).rows[0];
    expect([...row.settings.rebook_member_open_notified_recipients].sort()).toEqual(['g:a', 'p:b', 'p:c']);
    expect(row.settings.other).toBe('keep'); // sibling settings untouched
  });
});

// ── Finding #3: guest ACCOUNT resolution mirrors can_book_member_window's authorization precedence
//    (person_links → twin_of_profile_id → linked_profile_id, split-freeze). The claim's raw dual-key
//    player_id is NOT proof of an account. Same resolver feeds member-open + the auto-reminder SQL. ──
describe('PR 10d #3 — guest_verified_account_profile / resolve_guest_member_contacts', () => {
  const ACC = 'ac000000-0000-0000-0000-0000000000a1';   // the verified account profile
  const ACC2 = 'ac000000-0000-0000-0000-0000000000a2';  // a DIFFERENT profile (for conflicts)
  const PL = 'be000000-0000-0000-0000-000000000001';    // person for the person_links arms
  const PL2 = 'be000000-0000-0000-0000-000000000002';
  const G_LINKS = 'cc000000-0000-0000-0000-0000000000f1'; // person-links only
  const G_TWIN = 'cc000000-0000-0000-0000-0000000000f2';  // twin only
  const G_LINKED = 'cc000000-0000-0000-0000-0000000000f3'; // linked_profile only
  const G_CONFLICT = 'cc000000-0000-0000-0000-0000000000f4'; // twin=ACC, linked=ACC2 → twin wins
  const G_LINKS_TWIN = 'cc000000-0000-0000-0000-0000000000f5'; // person_links=ACC, twin=ACC2 → links win
  const G_FROZEN = 'cc000000-0000-0000-0000-0000000000f6'; // twin=ACC but split-frozen → NO account
  const G_NONE = 'cc000000-0000-0000-0000-0000000000f7';  // no relationship at all → NO account

  beforeAll(async () => {
    await db.exec(`
      INSERT INTO public.profiles (id, full_name, email) VALUES
        ('${ACC}','Account','acc@example.com'), ('${ACC2}','Account2','acc2@example.com');
      INSERT INTO public.persons (id) VALUES ('${PL}'), ('${PL2}');
      INSERT INTO public.guest_players (id, full_name, email, linked_profile_id, twin_of_profile_id, split_frozen) VALUES
        ('${G_LINKS}',      'Links',    NULL,               NULL,     NULL,     false),
        ('${G_TWIN}',       'Twin',     NULL,               NULL,     '${ACC}', false),
        ('${G_LINKED}',     'Linked',   NULL,               '${ACC}', NULL,     false),
        ('${G_CONFLICT}',   'Conflict', NULL,               '${ACC2}','${ACC}', false),
        ('${G_LINKS_TWIN}', 'LinksTwin',NULL,               NULL,     '${ACC2}',false),
        ('${G_FROZEN}',     'Frozen',   'frozen@example.com',NULL,    '${ACC}', true),
        ('${G_NONE}',       'Nobody',   'nobody@example.com',NULL,    NULL,     false);
      -- person_links: guest ↔ person ↔ profile
      INSERT INTO public.person_links (person_id, guest_player_id, profile_id) VALUES
        ('${PL}',  '${G_LINKS}',      NULL), ('${PL}',  NULL, '${ACC}'),
        ('${PL2}', '${G_LINKS_TWIN}', NULL), ('${PL2}', NULL, '${ACC}');
    `);
  });

  const account = async (g: string) =>
    (await db.query<{ p: string | null }>(`SELECT public.guest_verified_account_profile($1) AS p`, [g])).rows[0].p;

  it('person_links only → the linked profile', async () => { expect(await account(G_LINKS)).toBe(ACC); });
  it('twin only → the twin profile', async () => { expect(await account(G_TWIN)).toBe(ACC); });
  it('linked_profile only → the linked profile', async () => { expect(await account(G_LINKED)).toBe(ACC); });
  it('conflicting twin/link → the TWIN wins (link is transitional)', async () => { expect(await account(G_CONFLICT)).toBe(ACC); });
  it('person_links outranks twin → person_links wins', async () => { expect(await account(G_LINKS_TWIN)).toBe(ACC); });
  it('split-frozen → NO verified account (may be a different human)', async () => { expect(await account(G_FROZEN)).toBeNull(); });
  it('no relationship → NO verified account (raw player_id is never consulted)', async () => { expect(await account(G_NONE)).toBeNull(); });

  it('consume_rate_limit is atomic + fail-closed: consumes up to max, denies over, resets after the window (#4)', async () => {
    const consume = async (win = 60000) =>
      (await db.query<{ ok: boolean }>(`SELECT public.consume_rate_limit('tok-1','ep', 3, $1) AS ok`, [win])).rows[0].ok;
    expect(await consume()).toBe(true);  // 1
    expect(await consume()).toBe(true);  // 2
    expect(await consume()).toBe(true);  // 3 (== max)
    expect(await consume()).toBe(false); // 4 > max → denied (fail-closed on over-limit)
    // a SEPARATE token has its own bucket
    expect((await db.query<{ ok: boolean }>(`SELECT public.consume_rate_limit('tok-2','ep',3,60000) AS ok`)).rows[0].ok).toBe(true);
    // window expiry resets the count (window_ms=0 → the window is already past → reset to 1)
    expect(await consume(0)).toBe(true);
    const row = (await db.query<{ request_count: number }>(`SELECT request_count FROM public.rate_limits WHERE identifier='tok-1'`)).rows[0];
    expect(row.request_count).toBe(1); // reset, not accumulated (proves the RETURNING count is authoritative)
  });

  it('resolve_guest_member_contacts (batch): delivers to the account when no own email; flags has_account correctly', async () => {
    const rows = (await db.query<{ guest_id: string; own_email: string | null; account_email: string | null; has_account: boolean }>(
      `SELECT guest_id, own_email, account_email, has_account FROM public.resolve_guest_member_contacts($1::uuid[]) ORDER BY guest_id`,
      [[G_TWIN, G_FROZEN, G_NONE]],
    )).rows;
    const by = Object.fromEntries(rows.map((r) => [r.guest_id, r]));
    // twin-linked, no own email → delivered via the account, has_account
    expect(by[G_TWIN].own_email).toBeNull();
    expect(by[G_TWIN].account_email).toBe('acc@example.com');
    expect(by[G_TWIN].has_account).toBe(true);
    // split-frozen → own email only, NO account (so the sender would send signup CTA)
    expect(by[G_FROZEN].account_email).toBeNull();
    expect(by[G_FROZEN].has_account).toBe(false);
    // genuinely accountless → own email, no account
    expect(by[G_NONE].own_email).toBe('nobody@example.com');
    expect(by[G_NONE].has_account).toBe(false);
  });
});

// ── Finding #1: guests_have_rebook_contact is SCOPED to the caller's managed academy — an ordinary
//    or cross-tenant authenticated user cannot probe another academy's guests. ──────────────────────
describe('PR 10d #1 — guests_have_rebook_contact is academy-scoped (no cross-tenant oracle)', () => {
  const MGR = 'dd000000-0000-0000-0000-000000000001';   // manages ACAD (owns CYCLE with CHILD/CHILD2 claims)
  const ACAD2 = 'a0000000-0000-0000-0000-0000000000a2'; // a different academy
  const MGR2 = 'dd000000-0000-0000-0000-000000000002';  // manages ACAD2 (NOT ACAD)

  beforeAll(async () => {
    await db.exec(`
      INSERT INTO public.academy_profiles (id, name) VALUES ('${ACAD2}', 'Other Academy') ON CONFLICT DO NOTHING;
      INSERT INTO public.academy_managers (academy_profile_id, user_id) VALUES ('${ACAD}', '${MGR}'), ('${ACAD2}', '${MGR2}');
    `);
  });
  const asUser = async (uid: string | null, guestIds: string[]) => {
    await db.query(`SELECT set_config('test.uid', $1, false)`, [uid ?? '']);
    return (await db.query<{ guest_id: string; has_contact: boolean }>(
      `SELECT guest_id, has_contact FROM public.guests_have_rebook_contact($1::uuid[]) ORDER BY guest_id`, [guestIds])).rows;
  };

  it('a manager of the owning academy gets contact for its guests', async () => {
    const rows = await asUser(MGR, [CHILD, CHILD2]);
    const by = Object.fromEntries(rows.map((r) => [r.guest_id, r.has_contact]));
    expect(by[CHILD]).toBe(true);   // own email
    expect(by[CHILD2]).toBe(true);  // no own email but a verified (linked) account with one
  });

  it('a manager of a DIFFERENT academy gets NOTHING (cross-tenant probe fails closed)', async () => {
    expect(await asUser(MGR2, [CHILD, CHILD2])).toEqual([]);
  });

  it('an ordinary authenticated user managing no academy gets NOTHING', async () => {
    expect(await asUser('dd000000-0000-0000-0000-0000000000ff', [CHILD, CHILD2])).toEqual([]);
  });
});
