// @vitest-environment node
// Phase 3.6 (migration 20260907100000): person-correct dashboard head-counts.
// Pins: a merged profile+guest person counts ONCE (registered) in both dashboards'
// first_seen CTEs; a split-frozen guest counts as its OWN accountless person;
// is_registered keys on the person's LOGIN (3.3e doctrine) with profile-presence
// fallback for unstamped rows; first-seen month = the person's EARLIEST row.
// Runs the REAL migration file (the revenue/expense arms are re-emitted verbatim
// from 20260818100000 — this suite feeds no revenue rows and asserts only the
// players series + KPI head-counts).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACADEMY = '90000000-0000-0000-0000-000000000001';
const MGR_U = 'b0000000-0000-0000-0000-0000000000a1';
const TR = '30000000-0000-0000-0000-000000000001';
const TR_U = 'b0000000-0000-0000-0000-0000000000c1';
const SLOT = '50000000-0000-0000-0000-000000000001';
// merged person: profile P (login) + guest G
const P = 'a0000000-0000-0000-0000-000000000001';
const G = '70000000-0000-0000-0000-000000000001';
const PERSON = 'e0000000-0000-0000-0000-000000000001';
// frozen guest of the same person
const GF = '70000000-0000-0000-0000-000000000002';
// plain accountless guest
const G2 = '70000000-0000-0000-0000-000000000003';

const academyStats = async (): Promise<{ monthly: Array<{ new_registered: number; new_guest: number }>; kpis: Record<string, number> }> => {
  await db.exec(`SET test.uid = '${MGR_U}';`);
  const r = (await db.query<{ j: { monthly: Array<{ new_registered: number; new_guest: number }>; kpis: Record<string, number> } }>(
    `SELECT public.get_academy_dashboard_analytics($1, 6) AS j`, [ACADEMY])).rows[0].j;
  await db.exec(`SET test.uid = '';`);
  return r;
};
const trainerStats = async (): Promise<{ monthly: Array<{ new_registered: number; new_guest: number }>; kpis: Record<string, number> }> => {
  await db.exec(`SET test.uid = '${TR_U}';`);
  const r = (await db.query<{ j: { monthly: Array<{ new_registered: number; new_guest: number }>; kpis: Record<string, number> } }>(
    `SELECT public.get_trainer_dashboard_analytics(6) AS j`, [])).rows[0].j;
  await db.exec(`SET test.uid = '';`);
  return r;
};
const sums = (m: Array<{ new_registered: number; new_guest: number }>) => ({
  reg: m.reduce((a, x) => a + Number(x.new_registered), 0),
  guest: m.reduce((a, x) => a + Number(x.new_guest), 0),
});

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    -- Replicate Supabase's default privilege (auto-grants EXECUTE on new functions
    -- to anon/authenticated) so the anon-lockdown assertion below is meaningful.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;

    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid UNIQUE);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, player_id uuid, guest_player_id uuid, person_id uuid, status text,
      payment_amount numeric, payment_status text, paid_externally boolean,
      paid_at timestamptz, paid_by_player_id uuid, paid_by_guest_player_id uuid,
      created_at timestamptz DEFAULT now());
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, trainer_id uuid,
      academy_profile_id uuid, created_at timestamptz DEFAULT now());
    CREATE TABLE public.persons (id uuid PRIMARY KEY, user_id uuid UNIQUE);
    CREATE TABLE public.person_links (person_id uuid, profile_id uuid UNIQUE, guest_player_id uuid UNIQUE);
    CREATE TABLE public.person_merge_review (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text, status text, guest_player_id uuid);
    CREATE TABLE public.academy_player_locations (academy_profile_id uuid, profile_id uuid,
      guest_player_id uuid, person_id uuid, location_id uuid, dismissed boolean DEFAULT false,
      created_at timestamptz DEFAULT now());
    CREATE TABLE public.academy_managers (user_id uuid, academy_profile_id uuid);
    CREATE TABLE public.invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trainer_id uuid, academy_profile_id uuid, status text, total numeric, paid_at timestamptz,
      booking_ids uuid[], created_at timestamptz DEFAULT now());
    CREATE TABLE public.expenses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trainer_id uuid, academy_profile_id uuid, amount numeric, expense_date date);

    CREATE OR REPLACE FUNCTION public.is_academy_manager(_u uuid, _a uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT EXISTS (SELECT 1 FROM public.academy_managers WHERE user_id = _u AND academy_profile_id = _a) $fn$;
    CREATE OR REPLACE FUNCTION public.is_guest_split_frozen(_g uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT _g IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.person_merge_review r
          WHERE r.guest_player_id = _g AND r.status = 'pending'
            AND r.kind IN ('twin_detached_needs_split', 'merged_guest_email_moved')) $fn$;
  `);
  await db.exec(readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260907100000_phase36_dashboard_person_counts.sql'), 'utf8'));
  await db.exec(`
    INSERT INTO public.academy_managers VALUES ('${MGR_U}', '${ACADEMY}');
    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${TR}', '${TR_U}');
    INSERT INTO public.availability_slots (id, trainer_id) VALUES ('${SLOT}', '${TR}');
    INSERT INTO public.profiles (id, user_id) VALUES ('${P}', gen_random_uuid());
    INSERT INTO public.guest_players (id, trainer_id) VALUES
      ('${G}', '${TR}'), ('${GF}', '${TR}'), ('${G2}', '${TR}');
    INSERT INTO public.persons (id, user_id) VALUES ('${PERSON}', gen_random_uuid());
    INSERT INTO public.person_links (person_id, profile_id, guest_player_id) VALUES
      ('${PERSON}', '${P}', NULL), ('${PERSON}', NULL, '${G}'), ('${PERSON}', NULL, '${GF}');
    INSERT INTO public.person_merge_review (kind, status, guest_player_id)
      VALUES ('twin_detached_needs_split', 'pending', '${GF}');
  `);
});

describe('get_academy_dashboard_analytics first_seen (Phase 3.6)', () => {
  it('a merged person with rows under BOTH keys counts ONCE, as registered', async () => {
    await db.exec(`DELETE FROM public.academy_player_locations`);
    await db.query(
      `INSERT INTO public.academy_player_locations (academy_profile_id, profile_id, person_id) VALUES ($1, $2, $3)`,
      [ACADEMY, P, PERSON]);
    await db.query(
      `INSERT INTO public.academy_player_locations (academy_profile_id, guest_player_id, person_id) VALUES ($1, $2, $3)`,
      [ACADEMY, G, PERSON]);
    const stats = await academyStats();
    const s = sums(stats.monthly);
    expect(s.reg).toBe(1);   // ONE person, registered (has a login)
    expect(s.guest).toBe(0); // not also counted as a guest
  });

  it('a FROZEN guest counts as its OWN accountless person (not folded into the stamped person)', async () => {
    await db.exec(`DELETE FROM public.academy_player_locations`);
    await db.query(
      `INSERT INTO public.academy_player_locations (academy_profile_id, profile_id, person_id) VALUES ($1, $2, $3)`,
      [ACADEMY, P, PERSON]);
    await db.query(
      `INSERT INTO public.academy_player_locations (academy_profile_id, guest_player_id, person_id) VALUES ($1, $2, $3)`,
      [ACADEMY, GF, PERSON]); // frozen — stamp still present, must NOT merge
    const stats = await academyStats();
    const s = sums(stats.monthly);
    expect(s.reg).toBe(1);
    expect(s.guest).toBe(1); // the frozen guest, separately, as a guest
  });

  it('an UNSTAMPED accountless guest row degrades congruently (guest, once)', async () => {
    await db.exec(`DELETE FROM public.academy_player_locations`);
    await db.query(
      `INSERT INTO public.academy_player_locations (academy_profile_id, guest_player_id) VALUES ($1, $2)`,
      [ACADEMY, G2]);
    const stats = await academyStats();
    const s = sums(stats.monthly);
    expect(s.reg).toBe(0);
    expect(s.guest).toBe(1);
  });

  // Adversarial-verify P1 pin: `(pe.user_id IS NOT NULL)` is never NULL, so a
  // COALESCE profile-presence fallback off it was DEAD CODE — an unstamped
  // profile row silently misclassified as a guest. The CTE must key the
  // degradation on the persons-JOIN hit instead.
  it('an UNSTAMPED profile-keyed row still counts as REGISTERED (fallback is live)', async () => {
    await db.exec(`DELETE FROM public.academy_player_locations`);
    await db.query(
      `INSERT INTO public.academy_player_locations (academy_profile_id, profile_id) VALUES ($1, $2)`,
      [ACADEMY, P]);
    const stats = await academyStats();
    const s = sums(stats.monthly);
    expect(s.reg).toBe(1);
    expect(s.guest).toBe(0);
  });

  it('anon cannot execute either dashboard function (self-contained lockdown)', async () => {
    for (const fn of [
      'public.get_academy_dashboard_analytics(uuid, int)',
      'public.get_trainer_dashboard_analytics(int)',
    ]) {
      const { rows } = await db.query<{ ok: boolean }>(
        `SELECT has_function_privilege('anon', '${fn}', 'EXECUTE') AS ok`);
      expect(rows[0].ok).toBe(false);
    }
  });
});

describe('get_trainer_dashboard_analytics first_seen (Phase 3.6)', () => {
  it('a merged person (profile booking + owned guest row) counts ONCE, as registered', async () => {
    await db.exec(`DELETE FROM public.bookings`);
    await db.query(
      `INSERT INTO public.bookings (slot_id, player_id, person_id, status) VALUES ($1, $2, $3, 'confirmed')`,
      [SLOT, P, PERSON]);
    // G is owned by TR (guest arm) and links to the same person → must merge.
    const stats = await trainerStats();
    const s = sums(stats.monthly);
    // person counted once as registered; GF (frozen) + G2 (plain) count as guests.
    expect(s.reg).toBe(1);
    expect(s.guest).toBe(2);
  });

  it('cancelled bookings still grant nothing on the registered arm', async () => {
    await db.exec(`DELETE FROM public.bookings`);
    await db.query(
      `INSERT INTO public.bookings (slot_id, player_id, person_id, status) VALUES ($1, $2, $3, 'cancelled')`,
      [SLOT, P, PERSON]);
    const stats = await trainerStats();
    const s = sums(stats.monthly);
    expect(s.reg).toBe(0);
    // G (linked, non-frozen, no booking) resolves to the person → still a distinct
    // person entry via the guest arm; GF + G2 as before.
    expect(s.guest).toBe(3);
  });
});
