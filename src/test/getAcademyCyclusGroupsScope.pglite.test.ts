// @vitest-environment node
// Audit Batch 5 (§4.5): get_academy_cyclus_groups scoped by ACTIVE-trainer membership, so a trainer
// working in two academies leaked the other academy's slots + player NAMES, and a departed trainer's
// cycles reported "no players". This runs the REAL migration against Postgres (PGlite) and proves the
// academy_profile_id tenant boundary: only academy A's players are returned, B's are never leaked,
// and a departed trainer's academy slots still show their players.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACAD_A = '50000000-0000-0000-0000-0000000000a0';
const ACAD_B = '50000000-0000-0000-0000-0000000000b0';
const MGR_UID = '50000000-0000-0000-0000-0000000000e0'; // manages ACAD_A only
const T_SHARED = '50000000-0000-0000-0000-000000001001'; // active in A and B
const T_GONE = '50000000-0000-0000-0000-000000002002';   // departed from A

const groups = async (academyId: string) =>
  (await db.query<{ player_names: string[]; cyclus_id: string }>(
    `SELECT cyclus_id, player_names FROM public.get_academy_cyclus_groups($1::uuid)`, [academyId],
  )).rows;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT '${MGR_UID}'::uuid $fn$;
    -- The caller manages ACAD_A only (the IDOR gate).
    CREATE OR REPLACE FUNCTION public.get_user_academy_ids(_uid uuid) RETURNS SETOF uuid LANGUAGE sql STABLE AS $fn$ SELECT '${ACAD_A}'::uuid $fn$;

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
      player_id uuid, guest_player_id uuid, payment_status text, paid_externally boolean);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text);
    CREATE TABLE public.intake_requests (cycle_id uuid, player_id uuid, guest_player_id uuid, status text);

    INSERT INTO public.academy_profiles VALUES ('${ACAD_A}', 'Europe/Amsterdam'), ('${ACAD_B}', 'Europe/Amsterdam');
    INSERT INTO public.trainer_profiles VALUES ('${T_SHARED}', gen_random_uuid()), ('${T_GONE}', gen_random_uuid());

    -- Cycle + slot in ACADEMY A (shared trainer) with guest 'Alice A'
    INSERT INTO public.cycles (id, name, owner_id, owner_type, status, type) VALUES
      ('60000000-0000-0000-0000-0000000000a1', 'CycA', '${ACAD_A}', 'academy', 'active', 'cyclus'),
      ('60000000-0000-0000-0000-0000000000b1', 'CycB', '${ACAD_B}', 'academy', 'active', 'cyclus'),
      ('60000000-0000-0000-0000-0000000000d1', 'CycD', '${ACAD_A}', 'academy', 'active', 'cyclus');
    INSERT INTO public.availability_slots (id, start_time, end_time, max_participants, is_public, cyclus_id, trainer_id, academy_profile_id) VALUES
      ('70000000-0000-0000-0000-0000000000a1', '2999-01-01 10:00+00', '2999-01-01 11:00+00', 4, true, '60000000-0000-0000-0000-0000000000a1', '${T_SHARED}', '${ACAD_A}'),
      ('70000000-0000-0000-0000-0000000000b1', '2999-01-01 10:00+00', '2999-01-01 11:00+00', 4, true, '60000000-0000-0000-0000-0000000000b1', '${T_SHARED}', '${ACAD_B}'),
      ('70000000-0000-0000-0000-0000000000d1', '2999-01-08 10:00+00', '2999-01-08 11:00+00', 4, true, '60000000-0000-0000-0000-0000000000d1', '${T_GONE}', '${ACAD_A}');

    INSERT INTO public.guest_players (id, full_name) VALUES
      ('80000000-0000-0000-0000-0000000000a1', 'Alice A'),
      ('80000000-0000-0000-0000-0000000000b1', 'Bob B'),
      ('80000000-0000-0000-0000-0000000000d1', 'Carol D');
    INSERT INTO public.bookings (slot_id, status, guest_player_id, payment_status) VALUES
      ('70000000-0000-0000-0000-0000000000a1', 'confirmed', '80000000-0000-0000-0000-0000000000a1', 'paid'),
      ('70000000-0000-0000-0000-0000000000b1', 'confirmed', '80000000-0000-0000-0000-0000000000b1', 'paid'),
      ('70000000-0000-0000-0000-0000000000d1', 'confirmed', '80000000-0000-0000-0000-0000000000d1', 'paid');
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260813100000_get_academy_cyclus_groups_academy_scope.sql'), 'utf8'));
});

describe('get_academy_cyclus_groups — academy_profile_id tenant scope (audit Batch 5 §4.5)', () => {
  it('returns academy A players only — a shared trainer never leaks academy B, and a departed trainer still counts', async () => {
    const rows = await groups(ACAD_A);
    const names = rows.flatMap((r) => r.player_names ?? []);
    expect(names).toContain('Alice A');  // A's own slot
    expect(names).toContain('Carol D');  // departed trainer's academy-A slot still counts
    expect(names).not.toContain('Bob B'); // academy B's player NEVER leaks in via the shared trainer
    // exactly the two academy-A cycles, never B's
    expect(new Set(rows.map((r) => r.cyclus_id))).toEqual(
      new Set(['60000000-0000-0000-0000-0000000000a1', '60000000-0000-0000-0000-0000000000d1']),
    );
  });

  it('refuses an academy the caller does not manage (IDOR gate)', async () => {
    await expect(groups(ACAD_B)).rejects.toThrow(/not_authorized_for_academy/);
  });
});
