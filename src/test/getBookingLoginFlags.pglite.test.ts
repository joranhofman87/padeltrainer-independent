// @vitest-environment node
// Phase 3.5c: get_booking_login_flags (migration 20260905100000) — booking_id →
// person-level has_login for the staff Guest/Registered badges. Pins the arm
// order (person stamp → pure-profile seat → guest person-link), the split-freeze
// suspension, FAM-02 (dual-keyed rows resolve via the guest side), the authz
// scoping (only bookings on slots the caller manages; others silently omitted),
// and the anon EXECUTE denial. Runs the REAL migration file.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const TR = '30000000-0000-0000-0000-000000000001';
const TR_U = 'b0000000-0000-0000-0000-0000000000c1';
const OTHER_TR = '30000000-0000-0000-0000-000000000002';
const SLOT = '50000000-0000-0000-0000-000000000001';
const OTHER_SLOT = '50000000-0000-0000-0000-000000000002';
// login-holder person: profile P (user set) + guest G linked
const P = 'a0000000-0000-0000-0000-000000000001';
const G = '70000000-0000-0000-0000-000000000001';
const PERSON = 'e0000000-0000-0000-0000-000000000001';
// accountless guest
const G2 = '70000000-0000-0000-0000-000000000002';
// frozen guest of the login person
const GF = '70000000-0000-0000-0000-000000000003';

const flagsAs = async (uid: string, ids: string[]): Promise<Map<string, boolean>> => {
  await db.exec(`SET test.uid = '${uid}';`);
  const rows = (await db.query<{ booking_id: string; has_login: boolean }>(
    `SELECT * FROM public.get_booking_login_flags($1::uuid[])`, [ids])).rows;
  await db.exec(`SET test.uid = '';`);
  return new Map(rows.map((r) => [r.booking_id, r.has_login]));
};

const insertBooking = async (opts: { slot?: string; player?: string | null; guest?: string | null; person?: string | null }): Promise<string> => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.bookings (slot_id, player_id, guest_player_id, person_id, status)
     VALUES ($1, $2, $3, $4, 'confirmed') RETURNING id`,
    [opts.slot ?? SLOT, opts.player ?? null, opts.guest ?? null, opts.person ?? null]);
  return r.rows[0].id;
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE ROLE anon;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon;

    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid UNIQUE);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, trainer_id uuid,
      academy_profile_id uuid, location_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, player_id uuid, guest_player_id uuid, person_id uuid, status text);
    CREATE TABLE public.academy_managers (user_id uuid, academy_profile_id uuid);
    CREATE TABLE public.club_profiles (id uuid PRIMARY KEY, location_id uuid);
    CREATE TABLE public.club_managers (club_profile_id uuid, user_id uuid);
    CREATE TABLE public.user_roles (user_id uuid, role text);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY);
    CREATE TABLE public.persons (id uuid PRIMARY KEY, user_id uuid UNIQUE);
    CREATE TABLE public.person_links (person_id uuid, profile_id uuid UNIQUE, guest_player_id uuid UNIQUE);
    CREATE TABLE public.person_merge_review (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text, status text, guest_player_id uuid);

    CREATE OR REPLACE FUNCTION public.is_admin(_u uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _u AND role = 'admin') $fn$;
    CREATE OR REPLACE FUNCTION public.get_user_academy_ids(_u uuid)
      RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT academy_profile_id FROM public.academy_managers WHERE user_id = _u $fn$;
    CREATE OR REPLACE FUNCTION public.is_guest_split_frozen(_g uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT _g IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.person_merge_review r
          WHERE r.guest_player_id = _g AND r.status = 'pending'
            AND r.kind IN ('twin_detached_needs_split', 'merged_guest_email_moved')) $fn$;
  `);
  await db.exec(readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260905100000_phase35c_booking_login_flags.sql'), 'utf8'));
  await db.exec(`
    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${TR}', '${TR_U}'), ('${OTHER_TR}', gen_random_uuid());
    INSERT INTO public.availability_slots (id, trainer_id) VALUES ('${SLOT}', '${TR}'), ('${OTHER_SLOT}', '${OTHER_TR}');
    INSERT INTO public.profiles (id, user_id) VALUES ('${P}', gen_random_uuid());
    INSERT INTO public.guest_players (id) VALUES ('${G}'), ('${G2}'), ('${GF}');
    INSERT INTO public.persons (id, user_id) VALUES ('${PERSON}', gen_random_uuid());
    INSERT INTO public.person_links (person_id, profile_id, guest_player_id) VALUES
      ('${PERSON}', '${P}', NULL), ('${PERSON}', NULL, '${G}'), ('${PERSON}', NULL, '${GF}');
    INSERT INTO public.person_merge_review (kind, status, guest_player_id)
      VALUES ('merged_guest_email_moved', 'pending', '${GF}');
  `);
});

describe('get_booking_login_flags (Phase 3.5c)', () => {
  it('person arm: a stamped booking reads persons.user_id (guest seat of a login holder → true)', async () => {
    const id = await insertBooking({ guest: G, person: PERSON });
    const flags = await flagsAs(TR_U, [id]);
    expect(flags.get(id)).toBe(true);
  });

  it('guest link arm (unstamped): guest of a login person → true; accountless guest → false', async () => {
    const linked = await insertBooking({ guest: G });
    const plain = await insertBooking({ guest: G2 });
    const flags = await flagsAs(TR_U, [linked, plain]);
    expect(flags.get(linked)).toBe(true);
    expect(flags.get(plain)).toBe(false);
  });

  it('FROZEN guest is treated as accountless — in the PRODUCTION shape (stamped person_id)', async () => {
    // The stamp trigger keeps stamping during a pending review, so the real-world
    // frozen row carries person_id. Verify r1: the person arm must be freeze-gated
    // or this returns true (the possibly-wrong person's login).
    const stamped = await insertBooking({ guest: GF, person: PERSON });
    const unstamped = await insertBooking({ guest: GF });
    const flags = await flagsAs(TR_U, [stamped, unstamped]);
    expect(flags.get(stamped)).toBe(false);
    expect(flags.get(unstamped)).toBe(false);
  });

  it('AUTHZ arms: academy manager and admin resolve their slots; others omitted', async () => {
    const ACAD = '90000000-0000-0000-0000-000000000001';
    const ACAD_SLOT = '50000000-0000-0000-0000-000000000003';
    const MGR = 'b0000000-0000-0000-0000-0000000000d1';
    const ADMIN = 'b0000000-0000-0000-0000-0000000000e1';
    await db.exec(`
      INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id)
        VALUES ('${ACAD_SLOT}', '${OTHER_TR}', '${ACAD}');
      INSERT INTO public.academy_managers VALUES ('${MGR}', '${ACAD}');
      INSERT INTO public.user_roles VALUES ('${ADMIN}', 'admin');
    `);
    const acadBooking = await insertBooking({ slot: ACAD_SLOT, guest: G });
    const trainerBooking = await insertBooking({ guest: G });
    const mgrFlags = await flagsAs(MGR, [acadBooking, trainerBooking]);
    expect(mgrFlags.has(acadBooking)).toBe(true);
    expect(mgrFlags.has(trainerBooking)).toBe(false); // not their academy's slot
    const adminFlags = await flagsAs(ADMIN, [acadBooking, trainerBooking]);
    expect(adminFlags.has(acadBooking)).toBe(true);
    expect(adminFlags.has(trainerBooking)).toBe(true);
  });

  it('pure-profile seat: profiles.user_id decides; FAM-02: a dual-keyed unstamped row resolves via the GUEST side', async () => {
    const pure = await insertBooking({ player: P });
    const dualPlain = await insertBooking({ player: P, guest: G2 }); // guest side accountless → false
    const flags = await flagsAs(TR_U, [pure, dualPlain]);
    expect(flags.get(pure)).toBe(true);
    expect(flags.get(dualPlain)).toBe(false);
  });

  it('AUTHZ: bookings on another trainer\'s slot are silently omitted', async () => {
    const mine = await insertBooking({ guest: G2 });
    const theirs = await insertBooking({ slot: OTHER_SLOT, guest: G2 });
    const flags = await flagsAs(TR_U, [mine, theirs]);
    expect(flags.has(mine)).toBe(true);
    expect(flags.has(theirs)).toBe(false);
  });

  it('anon cannot execute (REVOKE pinned)', async () => {
    await db.exec(`SET ROLE anon;`);
    const denied = await db.query(`SELECT * FROM public.get_booking_login_flags(ARRAY[]::uuid[])`).then(() => false, () => true);
    await db.exec(`RESET ROLE;`);
    expect(denied).toBe(true);
  });
});
