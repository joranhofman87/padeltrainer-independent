// @vitest-environment node
// Phase 3.5b: person-keyed profile-visibility helpers (migration 20260904100000).
//
// Pins the BROKEN_NOW fix — an academy manager can update the profile of an
// EMAIL-MERGED person (person_links pair, no linked_profile_id/twin stamp) — plus
// the twin-precedence bridge, the split-freeze on both guest arms, the canonical
// inactive-booking filter, and the RELATIONSHIP-VISIBILITY doctrine (dual-keyed
// seats still grant — visibility helpers, not ownership predicates).
// Drives the REAL profiles UPDATE policy under SET ROLE authenticated.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACADEMY = '90000000-0000-0000-0000-000000000001';
const MGR_U = 'b0000000-0000-0000-0000-0000000000a1';
const TR = '30000000-0000-0000-0000-000000000001'; // academy trainer profile
const TR_U = 'b0000000-0000-0000-0000-0000000000c1';
const SLOT = '50000000-0000-0000-0000-000000000001';
// email-merged person: profile PM + guest GM share a person, NO twin/link stamp
const PM = 'a0000000-0000-0000-0000-000000000001';
const GM = '70000000-0000-0000-0000-000000000001';
const PERSON_M = 'e0000000-0000-0000-0000-000000000001';
// twin-bridged profile PT + guest GT (twin stamp, no person link)
const PT = 'a0000000-0000-0000-0000-000000000002';
const GT = '70000000-0000-0000-0000-000000000002';
// frozen-merged: profile PF + guest GF share a person, review pending
const PF = 'a0000000-0000-0000-0000-000000000003';
const GF = '70000000-0000-0000-0000-000000000003';
const PERSON_F = 'e0000000-0000-0000-0000-000000000003';
// unrelated profile
const PX = 'a0000000-0000-0000-0000-000000000009';

// The oracle pin means the fn returns false unless the CALLER manages the academy —
// run it with the manager uid set (matching how the policies invoke it).
const fnAcademy = async (player: string, callerUid = MGR_U): Promise<boolean> => {
  await db.exec(`SET test.uid = '${callerUid}';`);
  const r = (await db.query<{ r: boolean }>(`SELECT public.is_player_of_academy($1, $2) AS r`, [player, ACADEMY])).rows[0].r;
  await db.exec(`SET test.uid = '';`);
  return r;
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE ROLE anon;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;

    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid UNIQUE, full_name text);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, trainer_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, player_id uuid, guest_player_id uuid, status text);
    CREATE TABLE public.academy_trainers (trainer_profile_id uuid, academy_profile_id uuid, status text);
    CREATE TABLE public.academy_managers (user_id uuid, academy_profile_id uuid);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, trainer_id uuid,
      academy_profile_id uuid, twin_of_profile_id uuid, linked_profile_id uuid);
    CREATE TABLE public.persons (id uuid PRIMARY KEY);
    CREATE TABLE public.person_links (person_id uuid, profile_id uuid UNIQUE, guest_player_id uuid UNIQUE);
    CREATE TABLE public.person_merge_review (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text, status text, guest_player_id uuid);

    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    GRANT SELECT, UPDATE ON public.profiles TO authenticated;
    -- Prod reality: authenticated/anon can call auth.uid() (Supabase grants schema usage).
    GRANT USAGE ON SCHEMA auth TO authenticated, anon;

    -- Faithful copies of deployed helpers this migration depends on.
    CREATE TABLE public.user_roles (user_id uuid, role text);
    CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'admin') $fn$;
    CREATE OR REPLACE FUNCTION public.get_user_academy_ids(_user_id uuid)
      RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT academy_profile_id FROM public.academy_managers WHERE user_id = _user_id $fn$;
    CREATE OR REPLACE FUNCTION public.is_guest_split_frozen(_g uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT _g IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.person_merge_review r
          WHERE r.guest_player_id = _g AND r.status = 'pending'
            AND r.kind IN ('twin_detached_needs_split', 'merged_guest_email_moved')) $fn$;
  `);

  // Load the REAL migration (defines both helpers), then the REAL profiles UPDATE
  // policy (20260531120000 verbatim) which references is_player_of_academy.
  await db.exec(readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260904100000_phase35b_rls_helpers_person.sql'), 'utf8'));
  await db.exec(`
    CREATE POLICY "Academy managers can update booked player profiles"
      ON public.profiles FOR UPDATE TO authenticated
      USING (EXISTS (SELECT 1 FROM public.get_user_academy_ids(auth.uid()) AS aid
                     WHERE public.is_player_of_academy(id, aid)))
      WITH CHECK (EXISTS (SELECT 1 FROM public.get_user_academy_ids(auth.uid()) AS aid
                          WHERE public.is_player_of_academy(id, aid)));
  `);

  await db.exec(`
    INSERT INTO public.profiles (id, user_id, full_name) VALUES
      ('${PM}', gen_random_uuid(), 'Merged'), ('${PT}', gen_random_uuid(), 'Twin'),
      ('${PF}', gen_random_uuid(), 'Frozen'), ('${PX}', gen_random_uuid(), 'Unrelated');
    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${TR}', '${TR_U}');
    INSERT INTO public.availability_slots (id, trainer_id) VALUES ('${SLOT}', '${TR}');
    INSERT INTO public.academy_trainers VALUES ('${TR}', '${ACADEMY}', 'active');
    INSERT INTO public.academy_managers VALUES ('${MGR_U}', '${ACADEMY}');
    INSERT INTO public.guest_players (id, trainer_id, academy_profile_id, twin_of_profile_id, linked_profile_id) VALUES
      ('${GM}', NULL, '${ACADEMY}', NULL, NULL),
      ('${GT}', '${TR}', NULL, '${PT}', NULL),
      ('${GF}', NULL, '${ACADEMY}', NULL, NULL);
    INSERT INTO public.persons (id) VALUES ('${PERSON_M}'), ('${PERSON_F}');
    INSERT INTO public.person_links (person_id, profile_id, guest_player_id) VALUES
      ('${PERSON_M}', '${PM}', NULL), ('${PERSON_M}', NULL, '${GM}'),
      ('${PERSON_F}', '${PF}', NULL), ('${PERSON_F}', NULL, '${GF}');
    INSERT INTO public.person_merge_review (kind, status, guest_player_id)
      VALUES ('twin_detached_needs_split', 'pending', '${GF}');
  `);
});

describe('is_player_of_academy (Phase 3.5b)', () => {
  it('THE FIX: email-merged person (person_links only, no twin/link stamp) → TRUE', async () => {
    expect(await fnAcademy(PM)).toBe(true);
  });

  it('twin-precedence bridge still covers linked-but-unmerged guests', async () => {
    expect(await fnAcademy(PT)).toBe(true);
  });

  it('split-frozen guest grants NOTHING (person link exists but review pending)', async () => {
    expect(await fnAcademy(PF)).toBe(false);
  });

  it('unrelated profile → FALSE (no over-grant)', async () => {
    expect(await fnAcademy(PX)).toBe(false);
  });

  it('booking arm: active seat TRUE (incl. dual-keyed — relationship semantics); cancelled seat FALSE', async () => {
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, status) VALUES ($1, $2, 'confirmed')`, [SLOT, PX]);
    expect(await fnAcademy(PX)).toBe(true);
    await db.exec(`DELETE FROM public.bookings`);
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status) VALUES ($1, $2, $3, 'confirmed')`, [SLOT, PX, GM]);
    expect(await fnAcademy(PX)).toBe(true); // dual-keyed seat still evidences the relationship
    await db.exec(`DELETE FROM public.bookings`);
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, status) VALUES ($1, $2, 'cancelled')`, [SLOT, PX]);
    expect(await fnAcademy(PX)).toBe(false); // inactive seat
    await db.exec(`DELETE FROM public.bookings`);
  });

  it('ORACLE PIN: a non-manager caller gets FALSE even for a genuinely-linked player', async () => {
    expect(await fnAcademy(PM, TR_U)).toBe(false); // trainer ≠ academy manager
  });

  it('CROSS-TENANT: a guest at ANOTHER academy linking to the profile grants nothing here', async () => {
    const GB = '70000000-0000-0000-0000-0000000000b9';
    const PB = 'a0000000-0000-0000-0000-0000000000b9';
    const PERSON_B = 'e0000000-0000-0000-0000-0000000000b9';
    const OTHER_ACADEMY = '90000000-0000-0000-0000-000000000009';
    await db.query(`INSERT INTO public.profiles (id, user_id, full_name) VALUES ($1, gen_random_uuid(), 'CrossTenant')`, [PB]);
    await db.query(`INSERT INTO public.guest_players (id, academy_profile_id) VALUES ($1, $2)`, [GB, OTHER_ACADEMY]);
    await db.query(`INSERT INTO public.persons (id) VALUES ($1)`, [PERSON_B]);
    await db.query(`INSERT INTO public.person_links (person_id, profile_id) VALUES ($1, $2)`, [PERSON_B, PB]);
    await db.query(`INSERT INTO public.person_links (person_id, guest_player_id) VALUES ($1, $2)`, [PERSON_B, GB]);
    expect(await fnAcademy(PB)).toBe(false); // the linked guest is out of ACADEMY scope
  });

  it('PER-GUEST freeze: one frozen + one clean guest of the same person → the clean guest still grants', async () => {
    const GF2 = '70000000-0000-0000-0000-0000000000c9';
    await db.query(`INSERT INTO public.guest_players (id, academy_profile_id) VALUES ($1, $2)`, [GF2, ACADEMY]);
    await db.query(`INSERT INTO public.person_links (person_id, guest_player_id) VALUES ($1, $2)`, ['e0000000-0000-0000-0000-000000000003', GF2]);
    // PF's person now has GF (frozen) + GF2 (clean, in scope) → grants
    expect(await fnAcademy(PF)).toBe(true);
    await db.query(`DELETE FROM public.person_links WHERE guest_player_id = $1`, [GF2]);
    await db.query(`DELETE FROM public.guest_players WHERE id = $1`, [GF2]);
  });

  // PROD REALITY PIN (discovered building this suite): the manager UPDATE policy is
  // DORMANT — no client flow updates player profiles as a manager, AND prod has no
  // manager SELECT policy on player rows, so an UPDATE ... WHERE id=... silently
  // 0-rows (Postgres requires SELECT visibility for the WHERE). The helper fix makes
  // the policy CORRECT for when a surface arrives; enabling it then also needs a
  // matching SELECT policy (a deliberate GDPR decision, out of 3.5b scope).
  it('CURRENT prod shape: without a manager SELECT policy the UPDATE silently 0-rows', async () => {
    await db.exec(`SET test.uid = '${MGR_U}'; SET ROLE authenticated;`);
    try {
      await db.query(`UPDATE public.profiles SET full_name = 'Should Not Apply' WHERE id = $1`, [PM]);
    } finally {
      await db.exec(`RESET ROLE; SET test.uid = '';`);
    }
    const row = (await db.query<{ full_name: string }>(
      `SELECT full_name FROM public.profiles WHERE id = $1`, [PM])).rows[0];
    expect(row.full_name).toBe('Merged'); // untouched — SELECT visibility missing
  });

  it('FUTURE surface: with a manager SELECT policy, UPDATE reaches the merged person but not the frozen one', async () => {
    await db.exec(`
      CREATE POLICY "test manager select" ON public.profiles FOR SELECT TO authenticated
        USING (EXISTS (SELECT 1 FROM public.get_user_academy_ids(auth.uid()) AS aid
                       WHERE public.is_player_of_academy(id, aid)));
    `);
    await db.exec(`SET test.uid = '${MGR_U}'; SET ROLE authenticated;`);
    try {
      await db.query(`UPDATE public.profiles SET full_name = 'Merged Updated' WHERE id = $1`, [PM]);
      await db.query(`UPDATE public.profiles SET full_name = 'Frozen Updated' WHERE id = $1`, [PF]);
    } finally {
      await db.exec(`RESET ROLE; SET test.uid = '';`);
      await db.exec(`DROP POLICY "test manager select" ON public.profiles;`);
    }
    const rows = (await db.query<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM public.profiles WHERE id = ANY($1::uuid[])`, [[PM, PF]])).rows;
    expect(rows.find((r) => r.id === PM)!.full_name).toBe('Merged Updated');
    expect(rows.find((r) => r.id === PF)!.full_name).toBe('Frozen'); // freeze: RLS skipped it
  });
});

describe('is_player_of_trainer (Phase 3.5b)', () => {
  const fnTrainer = async (uid: string, player: string): Promise<boolean> => {
    await db.exec(`SET test.uid = '${uid}';`);
    const r = (await db.query<{ r: boolean }>(`SELECT public.is_player_of_trainer($1) AS r`, [player])).rows[0].r;
    await db.exec(`SET test.uid = '';`);
    return r;
  };

  it('active seat → TRUE (incl. dual-keyed — relationship semantics); cancelled → FALSE', async () => {
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, status) VALUES ($1, $2, 'confirmed')`, [SLOT, PX]);
    expect(await fnTrainer(TR_U, PX)).toBe(true);
    await db.exec(`DELETE FROM public.bookings`);
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status) VALUES ($1, $2, $3, 'confirmed')`, [SLOT, PX, GM]);
    expect(await fnTrainer(TR_U, PX)).toBe(true); // reporter-name surfaces depend on this (verify r1)
    await db.exec(`DELETE FROM public.bookings`);
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, status) VALUES ($1, $2, 'cancelled_swap')`, [SLOT, PX]);
    expect(await fnTrainer(TR_U, PX)).toBe(false);
    await db.exec(`DELETE FROM public.bookings`);
  });

  it('NULL status counts as confirmed (COALESCE)', async () => {
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, status) VALUES ($1, $2, NULL)`, [SLOT, PX]);
    expect(await fnTrainer(TR_U, PX)).toBe(true);
    await db.exec(`DELETE FROM public.bookings`);
  });
});
