// @vitest-environment node
// FAM-02 Level 1 + audit §4.0 for get_academy_cyclus_groups (migration 20260816100000), run as
// the REAL SQL against Postgres (PGlite):
//   • roster keyed by PERSON ('g:<guest>' / 'p:<player>'), not by name — two distinct same-named
//     people count as 2; a dual-keyed (linked guest) seat shows the guest's OWN name;
//   • booked_count uses the canonical hold-aware predicate (public.booking_occupies_seat) — a
//     live payment_pending hold occupies, an expired one does not;
//   • intake merge: person-keyed, with the historical name-suppression against booked names.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACAD = '50000000-0000-0000-0000-0000000000a0';
const MGR_UID = '50000000-0000-0000-0000-0000000000e0';
const TR = '50000000-0000-0000-0000-000000001001';
const CYC = '60000000-0000-0000-0000-0000000000a1';
const SLOT = '70000000-0000-0000-0000-0000000000a1';
const PARENT = '90000000-0000-0000-0000-000000000001'; // profile
const KID = '80000000-0000-0000-0000-000000000001'; // guest linked to PARENT (dual-keyed booking)
const JAN_P = '90000000-0000-0000-0000-000000000002'; // profile "Jan de Vries"
const JAN_G = '80000000-0000-0000-0000-000000000002'; // DISTINCT guest also named "Jan de Vries"

interface GroupRow {
  cyclus_id: string;
  player_names: string[];
  player_count: number;
  max_booked: number;
}

const groupsFor = async (): Promise<GroupRow[]> =>
  (await db.query<GroupRow>(
    `SELECT cyclus_id, player_names, player_count, max_booked FROM public.get_academy_cyclus_groups($1::uuid)`,
    [ACAD],
  )).rows;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT '${MGR_UID}'::uuid $fn$;
    CREATE OR REPLACE FUNCTION public.get_user_academy_ids(_uid uuid) RETURNS SETOF uuid LANGUAGE sql STABLE AS $fn$ SELECT '${ACAD}'::uuid $fn$;

    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY, timezone text);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, full_name text);
    CREATE TABLE public.locations (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.cycles (id uuid PRIMARY KEY, name text, owner_id uuid, owner_type text, status text, type text,
      start_date date, end_date date, price_per_session numeric, location_id uuid);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, start_time timestamptz, end_time timestamptz,
      max_participants int, is_public boolean, cyclus_id uuid, cyclus_name text, trainer_id uuid,
      price_per_session numeric, location_id uuid, academy_profile_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, status text,
      player_id uuid, guest_player_id uuid, payment_status text, paid_externally boolean,
      hold_expires_at timestamptz);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text);
    CREATE TABLE public.intake_requests (cycle_id uuid, player_id uuid, guest_player_id uuid, status text);

    INSERT INTO public.academy_profiles VALUES ('${ACAD}', 'Europe/Amsterdam');
    INSERT INTO public.trainer_profiles VALUES ('${TR}', gen_random_uuid());
    INSERT INTO public.profiles (id, user_id, full_name) VALUES
      ('${PARENT}', gen_random_uuid(), 'Parent Account'),
      ('${JAN_P}', gen_random_uuid(), 'Jan de Vries');
    INSERT INTO public.guest_players (id, full_name) VALUES
      ('${KID}', 'Kid Own Name'),
      ('${JAN_G}', 'Jan de Vries');
  `);
  // Prove replace-on-top: the previous emission first, then the person-key re-emit.
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260813100000_get_academy_cyclus_groups_academy_scope.sql'), 'utf8'));
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260816100000_academy_cyclus_groups_person_key.sql'), 'utf8'));
});

beforeEach(async () => {
  await db.exec(`
    DELETE FROM public.bookings; DELETE FROM public.intake_requests;
    DELETE FROM public.availability_slots; DELETE FROM public.cycles;
  `);
  await db.exec(`
    INSERT INTO public.cycles (id, name, owner_id, owner_type, status, type) VALUES
      ('${CYC}', 'Cyc', '${ACAD}', 'academy', 'active', 'cyclus');
    INSERT INTO public.availability_slots (id, start_time, end_time, max_participants, is_public, cyclus_id, trainer_id, academy_profile_id) VALUES
      ('${SLOT}', '2999-01-01 10:00+00', '2999-01-01 11:00+00', 4, true, '${CYC}', '${TR}', '${ACAD}');
  `);
});

describe('booking_occupies_seat — the canonical hold-aware occupying predicate', () => {
  it('capacity statuses occupy; a live payment_pending hold occupies; an expired one does not', async () => {
    const check = async (status: string | null, hold: string | null) =>
      (await db.query<{ occ: boolean }>(
        `SELECT public.booking_occupies_seat($1, $2::timestamptz) AS occ`, [status, hold],
      )).rows[0].occ;
    expect(await check('confirmed', null)).toBe(true);
    expect(await check('pending_approval', null)).toBe(true);
    expect(await check(null, null)).toBe(true); // NULL status defaults to confirmed (canonical form)
    expect(await check('cancelled', null)).toBe(false);
    expect(await check('payment_pending', '2999-01-01 00:00+00')).toBe(true); // live hold
    expect(await check('payment_pending', '2000-01-01 00:00+00')).toBe(false); // expired hold
    expect(await check('payment_pending', null)).toBe(false); // hold without expiry never counts
  });
});

describe('get_academy_cyclus_groups — person-keyed roster (FAM-02 Level 1)', () => {
  it('a dual-keyed seat is the GUEST person: own name, separate from the parent, and roster agrees with booked_count (M-17 pair)', async () => {
    await db.exec(`INSERT INTO public.bookings (slot_id, status, player_id, guest_player_id, payment_status) VALUES
      ('${SLOT}', 'confirmed', '${PARENT}', NULL, 'paid'),
      ('${SLOT}', 'confirmed', '${PARENT}', '${KID}', 'paid');`);
    const [g] = await groupsFor();
    expect(g.max_booked).toBe(2);
    expect(g.player_count).toBe(2); // 2 seats = 2 people — no more badge-2-roster-1
    expect([...g.player_names].sort()).toEqual(['Kid Own Name', 'Parent Account']);
  });

  it('two DISTINCT same-named people count as 2 (name appears twice)', async () => {
    await db.exec(`INSERT INTO public.bookings (slot_id, status, player_id, guest_player_id, payment_status) VALUES
      ('${SLOT}', 'confirmed', '${JAN_P}', NULL, 'paid'),
      ('${SLOT}', 'confirmed', NULL, '${JAN_G}', 'paid');`);
    const [g] = await groupsFor();
    expect(g.player_count).toBe(2);
    expect(g.player_names).toEqual(['Jan de Vries', 'Jan de Vries']);
  });

  it('booked_count counts a LIVE payment_pending hold, not an expired one; the roster stays hold-blind', async () => {
    await db.exec(`INSERT INTO public.bookings (slot_id, status, player_id, guest_player_id, payment_status, hold_expires_at) VALUES
      ('${SLOT}', 'confirmed', '${JAN_P}', NULL, 'paid', NULL),
      ('${SLOT}', 'payment_pending', NULL, '${JAN_G}', 'pending', '2999-01-01 00:00+00'),
      ('${SLOT}', 'payment_pending', NULL, '${KID}', 'pending', '2000-01-01 00:00+00');`);
    const [g] = await groupsFor();
    expect(g.max_booked).toBe(2); // confirmed + live hold; expired hold excluded
    expect(g.player_count).toBe(1); // roster = capacity statuses only (a hold has no seat-holder yet)
  });

  it('intake merge: same-name intake suppressed against booked names; a NEW person adds; same person (same key) never doubles', async () => {
    await db.exec(`INSERT INTO public.bookings (slot_id, status, player_id, guest_player_id, payment_status) VALUES
      ('${SLOT}', 'confirmed', '${JAN_P}', NULL, 'paid');`);
    await db.exec(`INSERT INTO public.intake_requests (cycle_id, player_id, guest_player_id, status) VALUES
      ('${CYC}', '${JAN_P}', NULL, 'confirmed'),      -- same person, same key → deduped
      ('${CYC}', NULL, '${JAN_G}', 'confirmed'),      -- DISTINCT person, same NAME → suppressed (historical merge)
      ('${CYC}', '${PARENT}', NULL, 'confirmed');     -- genuinely new person → added
    `);
    const [g] = await groupsFor();
    expect([...g.player_names].sort()).toEqual(['Jan de Vries', 'Parent Account']);
    expect(g.player_count).toBe(2);
  });

  it('IDOR gate regression: refuses an academy the caller does not manage', async () => {
    await expect(
      db.query(`SELECT * FROM public.get_academy_cyclus_groups('99999999-9999-9999-9999-999999999999'::uuid)`),
    ).rejects.toThrow(/not_authorized_for_academy/);
  });
});
