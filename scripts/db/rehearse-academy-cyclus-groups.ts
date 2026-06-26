/**
 * PGlite rehearsal for get_academy_cyclus_groups (20260630140000) — the server-side
 * cycle-overview aggregation. Real Postgres in WASM; runs the ACTUAL migration and asserts
 * PARITY with the JS grouping/payment logic in AcademyCyclusOverview.tsx:
 *   - real cyclus + slots -> one group per trainer; payment from bookings; intake merged.
 *   - registration cycle -> one group per weekly series (NO intake merge).
 *   - orphan slot group (no cycles row) -> has_cycle_row=false, status='active'.
 *   - no-slot non-registration cycle -> sessions=0, intake players, no_players.
 *   - no-slot registration cycle -> SKIPPED.
 *   - payment: active = confirmed/pending; all_paid iff every active paid (or paid_externally).
 *   - scope isolation (only the academy's trainers) + IDOR auth guard.
 *
 * Run: npx tsx scripts/db/rehearse-academy-cyclus-groups.ts
 */
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
};

// All UUIDs are valid hex.
const A1 = '11111111-1111-1111-1111-111111111111'; // academy managed by U1
const A2 = '11111111-1111-1111-1111-111111111112'; // other academy
const U1 = '22222222-2222-2222-2222-222222222221'; // manager of A1
const DEAD = '22222222-2222-2222-2222-2222222222de'; // user managing nothing
const T1 = '33333333-3333-3333-3333-333333333331'; // trainer_profiles.id in A1
const T2 = '33333333-3333-3333-3333-333333333332'; // trainer_profiles.id NOT in A1
const UT1 = '44444444-4444-4444-4444-444444444401'; // T1.user_id
const UT2 = '44444444-4444-4444-4444-444444444402'; // T2.user_id
const P1 = '55555555-5555-5555-5555-555555555551'; // profiles.id (player)
const UP1 = '55555555-5555-5555-5555-5555555555a1'; // P1.user_id
const TPROF = '66666666-6666-6666-6666-666666666661'; // profiles row for the trainer (name lookup)
const G1 = '77777777-7777-7777-7777-777777777771'; // guest player
const CY1 = '88888888-8888-8888-8888-888888888881'; // cyclus + 2 slots
const CY2 = '88888888-8888-8888-8888-888888888882'; // registration + 2 series
const CY3 = '88888888-8888-8888-8888-888888888883'; // no-slot cyclus + intake
const CY4 = '88888888-8888-8888-8888-888888888884'; // no-slot registration (skipped)
const CY5 = '88888888-8888-8888-8888-888888888885'; // registration, DST-spanning single series
const CY6 = '88888888-8888-8888-8888-888888888886'; // no-slot cyclus with NULL type
const CYA2 = '88888888-8888-8888-8888-8888888888a2'; // A2 cyclus
const ORPH = '99999999-9999-9999-9999-999999999991'; // orphan cyclus_id (no cycles row)
const S1 = 'aaaaaaaa-0000-0000-0000-000000000001'; // CY1 slot 1
const S2 = 'aaaaaaaa-0000-0000-0000-000000000002'; // CY1 slot 2
const S3 = 'aaaaaaaa-0000-0000-0000-000000000003'; // CY2 Mon series
const S4 = 'aaaaaaaa-0000-0000-0000-000000000004'; // CY2 Wed series
const S5 = 'aaaaaaaa-0000-0000-0000-000000000005'; // ORPH slot (earlier)
const S6 = 'aaaaaaaa-0000-0000-0000-000000000006'; // A2 slot
const S7 = 'aaaaaaaa-0000-0000-0000-000000000007'; // CY5 summer (Mon 18:00 CEST = 16:00Z)
const S8 = 'aaaaaaaa-0000-0000-0000-000000000008'; // CY5 winter (Mon 18:00 CET = 17:00Z)
const S9 = 'aaaaaaaa-0000-0000-0000-000000000009'; // ORPH slot (later, different cyclus_name)

const setUid = async (uid: string) => { await db.query(`SELECT set_config('test.uid', $1, false)`, [uid]); };

await db.exec(`
CREATE ROLE authenticated;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
CREATE TABLE public._acad_mgr (user_id uuid, academy_id uuid);
CREATE FUNCTION public.get_user_academy_ids(p_user uuid) RETURNS SETOF uuid
  LANGUAGE sql STABLE AS $$ SELECT academy_id FROM public._acad_mgr WHERE user_id = p_user $$;

CREATE TABLE public.academy_trainers (academy_profile_id uuid, trainer_profile_id uuid, status text);
CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, full_name text);
CREATE TABLE public.guest_players (id uuid PRIMARY KEY, full_name text);
CREATE TABLE public.locations (id uuid PRIMARY KEY, name text);
CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY, timezone text NOT NULL DEFAULT 'Europe/Amsterdam');
CREATE TABLE public.cycles (
  id uuid PRIMARY KEY, name text, owner_id uuid, owner_type text, status text, type text,
  start_date date, end_date date, price_per_session numeric, location_id uuid);
CREATE TABLE public.availability_slots (
  id uuid PRIMARY KEY, start_time timestamptz, end_time timestamptz, max_participants int,
  is_public boolean, cyclus_id uuid, cyclus_name text, trainer_id uuid, price_per_session numeric,
  location_id uuid);
CREATE TABLE public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, guest_player_id uuid,
  status text, payment_status text, paid_externally boolean);
CREATE TABLE public.intake_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cycle_id uuid, player_id uuid, guest_player_id uuid, status text);

-- mapping + identities
INSERT INTO public.academy_profiles VALUES ('${A1}', 'Europe/Amsterdam'), ('${A2}', 'Europe/Amsterdam');
INSERT INTO public._acad_mgr VALUES ('${U1}', '${A1}');
INSERT INTO public.academy_trainers VALUES ('${A1}', '${T1}', 'active'), ('${A2}', '${T2}', 'active');
INSERT INTO public.trainer_profiles VALUES ('${T1}', '${UT1}'), ('${T2}', '${UT2}');
INSERT INTO public.profiles VALUES
  ('${P1}', '${UP1}', 'Pieter Profile'),
  ('${TPROF}', '${UT1}', 'Trainer Tina');
INSERT INTO public.guest_players VALUES ('${G1}', 'Guus Guest');

-- CY1: academy cyclus, 2 slots, trainer T1.
INSERT INTO public.cycles VALUES ('${CY1}', 'Maandagtraining', '${A1}', 'academy', 'open', 'cyclus', '2026-06-01', '2026-08-01', 30, NULL);
INSERT INTO public.availability_slots VALUES
  ('${S1}', '2026-06-01 18:00:00+00', '2026-06-01 19:00:00+00', 4, true, '${CY1}', 'Maandagtraining', '${T1}', 30, NULL),
  ('${S2}', '2026-06-08 18:00:00+00', '2026-06-08 19:00:00+00', 4, true, '${CY1}', 'Maandagtraining', '${T1}', 30, NULL);
-- S1 bookings: P1 confirmed PAID, G1 confirmed UNPAID. S2: P1 confirmed PAID.
INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status, payment_status, paid_externally) VALUES
  ('${S1}', '${P1}', NULL, 'confirmed', 'paid', false),
  ('${S1}', NULL, '${G1}', 'confirmed', 'open', false),
  ('${S2}', '${P1}', NULL, 'confirmed', 'paid', false);

-- CY2: registration, 2 weekly series (Mon 18:00 + Wed 19:00), trainer T1.
INSERT INTO public.cycles VALUES ('${CY2}', 'Inschrijving', '${A1}', 'academy', 'open', 'registration', '2026-06-01', '2026-08-01', NULL, NULL);
INSERT INTO public.availability_slots VALUES
  ('${S3}', '2026-06-01 18:00:00+00', '2026-06-01 19:00:00+00', 4, true, '${CY2}', 'Inschrijving', '${T1}', NULL, NULL),
  ('${S4}', '2026-06-03 19:00:00+00', '2026-06-03 20:00:00+00', 4, true, '${CY2}', 'Inschrijving', '${T1}', NULL, NULL);
-- Mon series: P1 confirmed PAID. Wed series: no bookings.
INSERT INTO public.bookings (slot_id, player_id, status, payment_status, paid_externally) VALUES
  ('${S3}', '${P1}', 'confirmed', 'paid', false);
-- intake on CY2 (registration) — must NOT be merged.
INSERT INTO public.intake_requests (cycle_id, player_id, status) VALUES ('${CY2}', '${P1}', 'confirmed');

-- ORPH: two slots with cyclus_id not in cycles, trainer T1 → one orphan group.
-- The two slots carry DIFFERENT cyclus_name; D3 asserts the EARLIEST slot's name wins
-- (not the alphabetical max). Earliest (S5) = 'Aaa-vroeg'; later (S9) = 'Zzz-laat'.
-- S5 also has 1 booking confirmed UNPAID → payment has_unpaid.
INSERT INTO public.availability_slots VALUES
  ('${S5}', '2026-07-01 10:00:00+00', '2026-07-01 11:00:00+00', 4, false, '${ORPH}', 'Aaa-vroeg', '${T1}', 25, NULL),
  ('${S9}', '2026-07-08 10:00:00+00', '2026-07-08 11:00:00+00', 4, false, '${ORPH}', 'Zzz-laat', '${T1}', 25, NULL);
INSERT INTO public.bookings (slot_id, player_id, status, payment_status, paid_externally) VALUES
  ('${S5}', '${P1}', 'confirmed', 'open', false);

-- CY5: registration with ONE weekly Monday-18:00-Amsterdam series spanning a DST boundary.
-- Both slots are Monday 18:00 LOCAL (Amsterdam) but at different UTC times: summer 16:00Z (CEST),
-- winter 17:00Z (CET). UTC grouping would split them into 2 groups; AT TIME ZONE collapses to 1. (D1)
INSERT INTO public.cycles VALUES ('${CY5}', 'DST-formulier', '${A1}', 'academy', 'open', 'registration', '2026-06-01', '2026-12-31', NULL, NULL);
INSERT INTO public.availability_slots VALUES
  ('${S7}', '2026-07-06 16:00:00+00', '2026-07-06 17:00:00+00', 4, true, '${CY5}', 'DST-formulier', '${T1}', NULL, NULL),
  ('${S8}', '2026-11-30 17:00:00+00', '2026-11-30 18:00:00+00', 4, true, '${CY5}', 'DST-formulier', '${T1}', NULL, NULL);

-- CY6: no-slot cyclus with a NULL type + an intake — JS emits it; SQL must too (D7).
INSERT INTO public.cycles VALUES ('${CY6}', 'Type-loos', '${A1}', 'academy', 'open', NULL, '2026-06-01', '2026-08-01', NULL, NULL);
INSERT INTO public.intake_requests (cycle_id, player_id, status) VALUES ('${CY6}', '${P1}', 'confirmed');

-- CY3: no-slot cyclus with an intake.
INSERT INTO public.cycles VALUES ('${CY3}', 'Lege cyclus', '${A1}', 'academy', 'draft', 'cyclus', '2026-06-01', '2026-08-01', NULL, NULL);
INSERT INTO public.intake_requests (cycle_id, player_id, status) VALUES ('${CY3}', '${P1}', 'confirmed');

-- CY4: no-slot registration (must be SKIPPED).
INSERT INTO public.cycles VALUES ('${CY4}', 'Leeg formulier', '${A1}', 'academy', 'open', 'registration', '2026-06-01', '2026-08-01', NULL, NULL);

-- A2 scope: a cyclus+slot for trainer T2 (NOT in A1) — must be excluded from A1's result.
INSERT INTO public.cycles VALUES ('${CYA2}', 'Andere academie', '${A2}', 'academy', 'open', 'cyclus', '2026-06-01', '2026-08-01', 30, NULL);
INSERT INTO public.availability_slots VALUES
  ('${S6}', '2026-06-01 18:00:00+00', '2026-06-01 19:00:00+00', 4, true, '${CYA2}', 'Andere', '${T2}', 30, NULL);
`);

const fs = await import('node:fs');
const path = await import('node:path');
const migration = fs.readFileSync(
  path.join(process.cwd(), 'supabase', 'migrations', '20260630140000_get_academy_cyclus_groups.sql'),
  'utf8',
);
await db.exec(migration);

await setUid(U1);
const { rows } = await db.query<Record<string, unknown>>(`SELECT * FROM public.get_academy_cyclus_groups($1)`, [A1]);

const byCyc = (id: string) => rows.filter((r) => r.cyclus_id === id);

// Total groups for A1: CY1 (1) + CY2 (2) + CY5 (1, DST-collapsed) + ORPH (1) + CY3 (1) + CY6 (1) = 7.
// CY4 (no-slot registration) skipped, A2 excluded.
check('group count = 7 (CY1:1 + CY2:2 + CY5:1 + ORPH:1 + CY3:1 + CY6:1; CY4 skipped, A2 excluded)', rows.length === 7, { count: rows.length, cyc: rows.map((r) => r.cyclus_id) });
check('A2 cycle excluded (scope isolation)', !rows.some((r) => r.cyclus_id === CYA2));
check('CY4 (no-slot registration) skipped', byCyc(CY4).length === 0);

// D1: the DST-spanning registration series collapses to ONE group (academy-local tz, not UTC).
check('CY5: DST-spanning Mon-18:00 series = ONE group (AT TIME ZONE, not UTC split)', byCyc(CY5).length === 1, byCyc(CY5).map((g) => g.group_suffix));

// D7: a no-slot cycle with NULL type is emitted (IS DISTINCT FROM, not <>).
const cy6 = byCyc(CY6)[0];
check('CY6: NULL-type no-slot cycle emitted, sessions=0, group_type=cyclus, intake player', byCyc(CY6).length === 1 && Number(cy6?.sessions) === 0 && cy6?.group_type === 'cyclus' && JSON.stringify(cy6?.player_names) === JSON.stringify(['Pieter Profile']), cy6);

// D3: orphan group's cyclus_name_fallback = the EARLIEST slot's name, not the alphabetical max.
const orphName = byCyc(ORPH)[0];
check('ORPH: cyclus_name_fallback = earliest slot name (Aaa-vroeg), not max (Zzz-laat)', orphName?.cyclus_name_fallback === 'Aaa-vroeg', orphName?.cyclus_name_fallback);

const cy1 = byCyc(CY1)[0];
check('CY1: one group, has_cycle_row=true, sessions=2', byCyc(CY1).length === 1 && cy1?.has_cycle_row === true && Number(cy1?.sessions) === 2, cy1);
check('CY1: max_booked=2 (slot 1 has 2 bookings)', Number(cy1?.max_booked) === 2, cy1?.max_booked);
check('CY1: payment has_unpaid (one confirmed-paid + one confirmed-unpaid)', cy1?.payment_status_summary === 'has_unpaid', cy1?.payment_status_summary);
check('CY1: player_names sorted [Guus Guest, Pieter Profile]', JSON.stringify(cy1?.player_names) === JSON.stringify(['Guus Guest', 'Pieter Profile']), cy1?.player_names);
check('CY1: trainer_name resolved', cy1?.trainer_name === 'Trainer Tina', cy1?.trainer_name);
check('CY1: group_type=cyclus, status=open', cy1?.group_type === 'cyclus' && cy1?.status === 'open', { t: cy1?.group_type, s: cy1?.status });

const cy2 = byCyc(CY2);
check('CY2: TWO series groups, is_registration=true', cy2.length === 2 && cy2.every((g) => g.is_registration === true), cy2.map((g) => g.group_suffix));
const cy2paid = cy2.find((g) => g.payment_status_summary === 'all_paid');
const cy2empty = cy2.find((g) => g.payment_status_summary === 'no_players');
check('CY2: the booked series is all_paid, the other no_players', !!cy2paid && !!cy2empty, cy2.map((g) => g.payment_status_summary));
check('CY2: registration intake NOT merged (paid series has only the booked player)',
  JSON.stringify(cy2paid?.player_names) === JSON.stringify(['Pieter Profile']) && JSON.stringify(cy2empty?.player_names) === JSON.stringify([]),
  { paid: cy2paid?.player_names, empty: cy2empty?.player_names });

const orph = byCyc(ORPH)[0];
check('ORPH: has_cycle_row=false, status=active, type=cyclus, has_unpaid', orph?.has_cycle_row === false && orph?.status === 'active' && orph?.group_type === 'cyclus' && orph?.payment_status_summary === 'has_unpaid', orph);

const cy3 = byCyc(CY3)[0];
check('CY3: no-slot cyclus, sessions=0, intake player, no_players', Number(cy3?.sessions) === 0 && cy3?.payment_status_summary === 'no_players' && JSON.stringify(cy3?.player_names) === JSON.stringify(['Pieter Profile']), cy3);

// Auth: a user who does NOT manage the academy is blocked.
await setUid(DEAD);
let blocked = false;
try { await db.query(`SELECT * FROM public.get_academy_cyclus_groups($1)`, [A1]); } catch { blocked = true; }
check('IDOR guard: non-manager is blocked', blocked);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
