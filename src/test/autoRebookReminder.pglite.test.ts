// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// The automated rebook reminder runs the REAL migration (20260721100000) against Postgres
// (PGlite) and proves the detection RPC rebook_claims_needing_auto_reminder() only returns
// genuine non-responders due for a reminder: claim still 'pending' (not booked), did NOT
// decline, NOT already reminded, priority window closing within the lead time, has an email,
// on a rebook round with auto-reminder not disabled — one representative row per invitee.
//
// HISTORICAL SCOPE NOTE (D7 runtime cutover). The fixture below `CREATE FUNCTION`s the member-open
// shim signatures so this migration's own REVOKE/GRANT statements resolve when it is replayed in
// isolation. Those stubs are PLATFORM SCAFFOLDING for a historical file, not a claim that the live
// schema still carries the functions — 20261119110000 drops all four. The stubs must stay: without
// them the replay of an immutable, shipped migration fails.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACAD = 'c0000000-0000-0000-0000-0000000000a0';
const C_REBOOK = 'c1000000-0000-0000-0000-000000000001'; // rebook round, auto-reminder ON
const C_OPTOUT = 'c1000000-0000-0000-0000-000000000002'; // rebook round, auto-reminder OFF
const C_NOTREBOOK = 'c1000000-0000-0000-0000-000000000003'; // not a rebook round
// slots on C_REBOOK
const S_SOON_A = '50000000-0000-0000-0000-0000000000a1'; // window in +12h
const S_SOON_B = '50000000-0000-0000-0000-0000000000a2'; // window in +12h (same player, 2nd series)
const S_FAR = '50000000-0000-0000-0000-0000000000a3';    // window in +48h (outside lead)
const S_PAST = '50000000-0000-0000-0000-0000000000a4';   // window already closed
const S_OPTOUT = '50000000-0000-0000-0000-0000000000b1'; // on C_OPTOUT
const S_NOTREBOOK = '50000000-0000-0000-0000-0000000000c1'; // on C_NOTREBOOK

const P1 = 'aa000000-0000-0000-0000-000000000001'; // eligible (pending, email, in window)
const P_DECLINED = 'aa000000-0000-0000-0000-000000000002';
const P_BOOKED = 'aa000000-0000-0000-0000-000000000003';
const P_NOEMAIL = 'aa000000-0000-0000-0000-000000000004';
const P_REMINDED = 'aa000000-0000-0000-0000-000000000005';
const P_FAR = 'aa000000-0000-0000-0000-000000000006';
const P_PAST = 'aa000000-0000-0000-0000-000000000007';
const P_OPTOUT = 'aa000000-0000-0000-0000-000000000008';
const P_NOTREBOOK = 'aa000000-0000-0000-0000-000000000009';
const G1 = 'bb000000-0000-0000-0000-000000000001'; // eligible guest

const rows = async () =>
  (await db.query<{
    cycle_id: string; player_id: string | null; guest_player_id: string | null; recipient_email: string;
  }>(`SELECT * FROM public.rebook_claims_needing_auto_reminder(24)`)).rows;

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
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, cyclus_id uuid, start_time timestamptz, priority_window_ends_at timestamptz);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, guest_player_id uuid,
      status text, response_intent text, reminded_at timestamptz, reminder_count int DEFAULT 0,
      claim_token text DEFAULT gen_random_uuid()::text);

    INSERT INTO public.academy_profiles VALUES ('${ACAD}', 'RL Padel');
    INSERT INTO public.profiles (id, full_name, email) VALUES
      ('${P1}','P1','p1@example.com'), ('${P_DECLINED}','Pd','pd@example.com'),
      ('${P_BOOKED}','Pb','pb@example.com'), ('${P_NOEMAIL}','Pn', NULL),
      ('${P_REMINDED}','Pr','pr@example.com'), ('${P_FAR}','Pf','pf@example.com'),
      ('${P_PAST}','Pp','pp@example.com'), ('${P_OPTOUT}','Po','po@example.com'),
      ('${P_NOTREBOOK}','Px','px@example.com');
    INSERT INTO public.guest_players (id, full_name, email) VALUES ('${G1}','G1','g1@example.com');

    INSERT INTO public.cycles (id, name, owner_type, owner_id, settings) VALUES
      ('${C_REBOOK}','Ronde','academy','${ACAD}','{"rebook_payment_mode":"upfront"}'),
      ('${C_OPTOUT}','Ronde opt-out','academy','${ACAD}','{"rebook_payment_mode":"upfront","rebook_auto_reminder":false}'),
      ('${C_NOTREBOOK}','Gewone cyclus','academy','${ACAD}','{}');

    -- start_time (the SESSION time) is set for every slot so the PR 10d future-session guard
    -- (s.start_time > app_now()) leaves each existing eligibility decision unchanged: future sessions
    -- for the open windows, a past session for the already-closed window (S_PAST). Session starts an
    -- hour+ after its priority window closes; S_SOON_A sits 2h past its window so the app_now
    -- time-travel block never brushes the guard against equality (window drives those cases).
    INSERT INTO public.availability_slots (id, cyclus_id, start_time, priority_window_ends_at) VALUES
      ('${S_SOON_A}','${C_REBOOK}', now() + interval '14 hours', now() + interval '12 hours'),
      ('${S_SOON_B}','${C_REBOOK}', now() + interval '14 hours', now() + interval '12 hours'),
      ('${S_FAR}','${C_REBOOK}',    now() + interval '50 hours', now() + interval '48 hours'),
      ('${S_PAST}','${C_REBOOK}',   now() - interval '1 hour',   now() - interval '2 hours'),
      ('${S_OPTOUT}','${C_OPTOUT}', now() + interval '14 hours', now() + interval '12 hours'),
      ('${S_NOTREBOOK}','${C_NOTREBOOK}', now() + interval '14 hours', now() + interval '12 hours');

    INSERT INTO public.slot_priority_claims (slot_id, player_id, guest_player_id, status, response_intent, reminded_at) VALUES
      ('${S_SOON_A}','${P1}', NULL, 'pending', NULL, NULL),                       -- ELIGIBLE
      ('${S_SOON_B}','${P1}', NULL, 'pending', NULL, NULL),                       -- same player, dedup to 1
      ('${S_SOON_A}', NULL, '${G1}', 'pending', NULL, NULL),                      -- ELIGIBLE guest
      ('${S_SOON_A}','${P_DECLINED}', NULL, 'pending', 'decline', NULL),          -- declined → excluded
      ('${S_SOON_A}','${P_BOOKED}', NULL, 'claimed', NULL, NULL),                 -- booked → excluded
      ('${S_SOON_A}','${P_NOEMAIL}', NULL, 'pending', NULL, NULL),                -- no email → excluded
      ('${S_SOON_A}','${P_REMINDED}', NULL, 'pending', NULL, now() - interval '1 hour'), -- already reminded → excluded
      ('${S_FAR}','${P_FAR}', NULL, 'pending', NULL, NULL),                       -- window too far → excluded
      ('${S_PAST}','${P_PAST}', NULL, 'pending', NULL, NULL),                     -- window closed → excluded
      ('${S_OPTOUT}','${P_OPTOUT}', NULL, 'pending', NULL, NULL),                 -- opt-out round → excluded
      ('${S_NOTREBOOK}','${P_NOTREBOOK}', NULL, 'pending', NULL, NULL);           -- not a rebook round → excluded
  `);
  // Load only the RPC + the guarded cron DO block (pg_cron absent → the block RAISE NOTICE + RETURNs).
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260721100000_auto_rebook_reminder.sql'), 'utf8'));
  // The Vault-based reschedule migration must apply cleanly on top (pg_cron absent → it also
  // RAISE NOTICE + RETURNs at the guard, never touching cron.job / vault) and must not disturb
  // the detection RPC. Loading it here proves both.
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260722100000_rebook_crons_use_vault.sql'), 'utf8'));
  // The app_now() clock migration re-emits the detection RPC with now() → app_now(); loading it
  // last lets the time-travel block below set app.fake_now and move "now" around a fixed deadline.
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260724100000_app_now_clock.sql'), 'utf8'));
  // Per-cycle lead override (settings.rebook_reminder_lead_hours).
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260806100000_rebook_reminder_lead_per_cycle.sql'), 'utf8'));
  // The member-open cron trio (real defs live in 20260714110000 / 20260817100000) — stubbed with the
  // SAME signatures so the PR 10d migration's grant lockdown on them applies without erroring here.
  await db.exec(`
    CREATE FUNCTION public.rebook_cycles_needing_member_open_notice() RETURNS TABLE(cycle_id uuid)
      LANGUAGE sql SECURITY DEFINER AS $fn$ SELECT NULL::uuid WHERE false $fn$;
    CREATE FUNCTION public.claim_rebook_member_open_notice(_cycle_id uuid) RETURNS boolean
      LANGUAGE sql SECURITY DEFINER AS $fn$ SELECT true $fn$;
    CREATE FUNCTION public.unclaim_rebook_member_open_notice(_cycle_id uuid) RETURNS void
      LANGUAGE sql SECURITY DEFINER AS $fn$ SELECT $fn$;
  `);
  // PR 10d: guest-first re-emit (+ the bump_rebook_reminders guard). This must preserve every
  // eligibility/lead/app_now behaviour above for pure-profile + pure-guest rows (their guest-first
  // key equals the old player-first key), so the existing suite is now regression coverage for it.
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260927100000_rebook_identity_guest_first.sql'), 'utf8'));
  // PR 10d follow-up: the future-session guard (s.start_time > app_now()). A past session can never
  // qualify even with a malformed future priority deadline. Must preserve every eligibility decision
  // above (all the existing assertions become its regression coverage), and adds the new guard.
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260930100000_rebook_auto_reminder_future_slot_guard.sql'), 'utf8'));
});

describe('rebook_claims_needing_auto_reminder', () => {
  it('returns ONLY genuine non-responders due for a reminder — one per invitee', async () => {
    const r = await rows();
    const keys = r.map((x) => x.player_id ?? `g:${x.guest_player_id}`).sort();
    expect(keys).toEqual([`g:${G1}`, P1].sort());
    // every returned row is on the rebook round and has an email
    expect(r.every((x) => x.cycle_id === C_REBOOK)).toBe(true);
    expect(r.every((x) => !!x.recipient_email)).toBe(true);
  });

  it('excludes declined, booked, emailless, already-reminded, out-of-window, opt-out and non-rebook', async () => {
    const r = await rows();
    const keys = new Set(r.map((x) => x.player_id ?? `g:${x.guest_player_id}`));
    for (const excluded of [P_DECLINED, P_BOOKED, P_NOEMAIL, P_REMINDED, P_FAR, P_PAST, P_OPTOUT, P_NOTREBOOK]) {
      expect(keys.has(excluded)).toBe(false);
    }
  });

  it('collapses a player with multiple pending series to a single reminder row', async () => {
    const r = await rows();
    expect(r.filter((x) => x.player_id === P1)).toHaveLength(1);
  });

  it('honours the lead-hours arg (0 window before deadline → nobody)', async () => {
    const near = (await db.query(`SELECT count(*)::int AS n FROM public.rebook_claims_needing_auto_reminder(1)`)).rows[0] as { n: number };
    // P1/G1's window is +12h, so a 1-hour lead excludes them.
    expect(near.n).toBe(0);
  });

  // Per-cycle override: settings.rebook_reminder_lead_hours beats the caller's _lead_hours.
  describe('per-cycle rebook_reminder_lead_hours override', () => {
    afterEach(async () => {
      await db.query(`UPDATE public.cycles SET settings = settings - 'rebook_reminder_lead_hours' WHERE id = '${C_REBOOK}'`);
    });

    it('a 72h round lead makes the +48h claim due even though the cron passes 24', async () => {
      await db.query(`UPDATE public.cycles SET settings = settings || '{"rebook_reminder_lead_hours": 72}' WHERE id = '${C_REBOOK}'`);
      const keys = (await rows()).map((x) => x.player_id ?? `g:${x.guest_player_id}`);
      expect(keys).toContain(P_FAR); // +48h window, inside the 72h round lead
    });

    it('a 6h round lead excludes the +12h claims even though the cron passes 24', async () => {
      await db.query(`UPDATE public.cycles SET settings = settings || '{"rebook_reminder_lead_hours": 6}' WHERE id = '${C_REBOOK}'`);
      const keys = (await rows()).map((x) => x.player_id ?? `g:${x.guest_player_id}`);
      expect(keys).not.toContain(P1);
      expect(keys).not.toContain(P_FAR);
    });

    it('junk / non-numeric values fall back to the caller lead instead of erroring the cron', async () => {
      await db.query(`UPDATE public.cycles SET settings = settings || '{"rebook_reminder_lead_hours": "soon"}' WHERE id = '${C_REBOOK}'`);
      const keys = (await rows()).map((x) => x.player_id ?? `g:${x.guest_player_id}`);
      expect(keys.sort()).toEqual([`g:${G1}`, P1].sort()); // old 24h behavior
    });

    it('absent key → behavior identical to before the migration', async () => {
      const keys = (await rows()).map((x) => x.player_id ?? `g:${x.guest_player_id}`);
      expect(keys.sort()).toEqual([`g:${G1}`, P1].sort());
      expect(keys).not.toContain(P_FAR);
    });
  });
});

// The app_now() clock (migration 20260724100000) lets a test travel to any instant via the
// app.fake_now GUC; in prod the GUC is never set so app_now() IS now(). Here we hold the
// deadline fixed and move "now" around it to prove reminder eligibility flips deterministically.
describe('app_now() time-travel (fake clock)', () => {
  const atOffset = (expr: string) =>
    `SELECT set_config('app.fake_now', (SELECT (priority_window_ends_at ${expr})::text FROM public.availability_slots WHERE id='${S_SOON_A}'), false)`;
  const dueKeys = async () => (await rows()).map((x) => x.player_id ?? `g:${x.guest_player_id}`);
  afterEach(async () => { await db.query(`SELECT set_config('app.fake_now', '', false)`); });

  it('fake_now unset → app_now() === now() (no behaviour change)', async () => {
    expect((await dueKeys()).sort()).toEqual([`g:${G1}`, P1].sort());
  });

  it('6h before the deadline → the reminder is due', async () => {
    await db.query(atOffset(`- interval '6 hours'`));
    expect(await dueKeys()).toContain(P1);
  });

  it('48h before the deadline → NOT yet due (outside the 24h lead)', async () => {
    await db.query(atOffset(`- interval '48 hours'`));
    expect(await dueKeys()).not.toContain(P1);
  });

  it('after the deadline has passed → NOT due', async () => {
    await db.query(atOffset(`+ interval '1 hour'`));
    expect(await dueKeys()).not.toContain(P1);
  });
});

// Finding #3 end-to-end: the auto-reminder RPC delivers a twin-linked guest (no own email) to their
// VERIFIED ACCOUNT profile's email — proving the RPC's guest_verified_account_profile join, not just
// the shared helper. Isolated in its own cycle + cleaned up so the shared assertions are unaffected.
describe('auto-reminder RPC: guest account-email fallback (finding #3)', () => {
  const C_ACC = 'c1000000-0000-0000-0000-0000000000e1';
  const S_ACC = '50000000-0000-0000-0000-0000000000e1';
  const ACC = 'ac000000-0000-0000-0000-0000000000e1';       // account profile
  const G_TWIN = 'bb000000-0000-0000-0000-0000000000e1';    // twin guest, NO own email

  beforeAll(async () => {
    await db.exec(`
      INSERT INTO public.profiles (id, full_name, email) VALUES ('${ACC}','Account','acc@example.com');
      INSERT INTO public.guest_players (id, full_name, email, twin_of_profile_id) VALUES ('${G_TWIN}','Twin Guest', NULL, '${ACC}');
      INSERT INTO public.cycles (id, name, owner_type, owner_id, settings) VALUES ('${C_ACC}','AccRonde','academy','${ACAD}','{"rebook_payment_mode":"upfront"}');
      INSERT INTO public.availability_slots (id, cyclus_id, start_time, priority_window_ends_at) VALUES ('${S_ACC}','${C_ACC}', now() + interval '14 hours', now() + interval '12 hours');
      INSERT INTO public.slot_priority_claims (slot_id, player_id, guest_player_id, status, response_intent, reminded_at) VALUES ('${S_ACC}', NULL, '${G_TWIN}', 'pending', NULL, NULL);
    `);
  });
  afterAll(async () => {
    await db.exec(`
      DELETE FROM public.slot_priority_claims WHERE slot_id = '${S_ACC}';
      DELETE FROM public.availability_slots WHERE id = '${S_ACC}';
      DELETE FROM public.cycles WHERE id = '${C_ACC}';
      DELETE FROM public.guest_players WHERE id = '${G_TWIN}';
      DELETE FROM public.profiles WHERE id = '${ACC}';
    `);
  });

  it('a twin-linked guest with no own email is delivered to the verified ACCOUNT email + shows their own name', async () => {
    const row = (await db.query<{ guest_player_id: string | null; recipient_email: string; recipient_name: string }>(
      `SELECT guest_player_id, recipient_email, recipient_name FROM public.rebook_claims_needing_auto_reminder(24) WHERE guest_player_id = '${G_TWIN}'`,
    )).rows[0];
    expect(row).toBeTruthy();
    expect(row.recipient_email).toBe('acc@example.com'); // NOT dropped, NOT the raw player_id
    expect(row.recipient_name).toBe('Twin Guest');       // own name wins
  });
});

// PR 10d follow-up (owner-requested): a PAST session must NEVER produce an auto-reminder, even if its
// priority deadline is MALFORMED and still in the future. Migration 20260930100000 adds the guard
// `s.start_time > app_now()`. This row is eligible on EVERY other axis (rebook round, pending, not
// declined, not reminded, has email, window future + within the 24h lead) — so the past start_time is
// the ONLY thing excluding it, proven load-bearing by flipping start_time to the future.
describe('future-session guard: a past session never reminds (PR 10d follow-up)', () => {
  const C_PS = 'c1000000-0000-0000-0000-0000000000f1';
  const S_PS = '50000000-0000-0000-0000-0000000000f1';
  const P_PS = 'aa000000-0000-0000-0000-0000000000f1';

  beforeAll(async () => {
    await db.exec(`
      INSERT INTO public.profiles (id, full_name, email) VALUES ('${P_PS}','PastSession','ps@example.com');
      INSERT INTO public.cycles (id, name, owner_type, owner_id, settings) VALUES ('${C_PS}','PastRonde','academy','${ACAD}','{"rebook_payment_mode":"upfront"}');
      -- session ALREADY happened (start_time in the past) but the priority deadline is malformed-future (+12h, within lead)
      INSERT INTO public.availability_slots (id, cyclus_id, start_time, priority_window_ends_at)
        VALUES ('${S_PS}','${C_PS}', now() - interval '2 hours', now() + interval '12 hours');
      INSERT INTO public.slot_priority_claims (slot_id, player_id, guest_player_id, status, response_intent, reminded_at)
        VALUES ('${S_PS}','${P_PS}', NULL, 'pending', NULL, NULL);
    `);
  });
  afterAll(async () => {
    await db.exec(`
      DELETE FROM public.slot_priority_claims WHERE slot_id = '${S_PS}';
      DELETE FROM public.availability_slots WHERE id = '${S_PS}';
      DELETE FROM public.cycles WHERE id = '${C_PS}';
      DELETE FROM public.profiles WHERE id = '${P_PS}';
    `);
  });

  it('a past session with a future priority deadline returns NO reminder', async () => {
    const keys = (await rows()).map((x) => x.player_id ?? `g:${x.guest_player_id}`);
    expect(keys).not.toContain(P_PS);
  });

  it('is excluded ONLY by the past start_time — moving the session into the future makes it due (guard is load-bearing)', async () => {
    await db.query(`UPDATE public.availability_slots SET start_time = now() + interval '13 hours' WHERE id = '${S_PS}'`);
    const keys = (await rows()).map((x) => x.player_id ?? `g:${x.guest_player_id}`);
    expect(keys).toContain(P_PS); // only the start_time axis changed → it flips to eligible
    await db.query(`UPDATE public.availability_slots SET start_time = now() - interval '2 hours' WHERE id = '${S_PS}'`);
  });
});
