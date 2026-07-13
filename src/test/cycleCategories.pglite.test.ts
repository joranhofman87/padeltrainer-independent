// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Cycle categories (migration 20260820100000): the academy's managed colored catalog +
// cycles.category_id, surfaced by get_academy_cyclus_groups as category_id/name/color. Runs the
// REAL migration chain against Postgres.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACAD = '50000000-0000-0000-0000-0000000000a0';
const MGR_UID = '50000000-0000-0000-0000-0000000000e0';
const TR = '50000000-0000-0000-0000-000000001001';
const CY = '60000000-0000-0000-0000-000000000004';
const CAT = 'c1000000-0000-0000-0000-000000000001';

const m = (f: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8');
const catByCyclus = async (): Promise<Record<string, { name: string | null; color: string | null }>> => {
  const { rows } = await db.query<{ cyclus_id: string; category_name: string | null; category_color: string | null }>(
    `SELECT cyclus_id, category_name, category_color FROM public.get_academy_cyclus_groups($1::uuid)`, [ACAD]);
  return Object.fromEntries(rows.map((r) => [r.cyclus_id, { name: r.category_name, color: r.category_color }]));
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT '${MGR_UID}'::uuid $fn$;
    CREATE OR REPLACE FUNCTION public.get_user_academy_ids(_uid uuid) RETURNS SETOF uuid LANGUAGE sql STABLE AS $fn$ SELECT '${ACAD}'::uuid $fn$;
    CREATE OR REPLACE FUNCTION public.is_academy_manager(_uid uuid, _acad uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT true $fn$;
    CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $fn$;

    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY, timezone text);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, full_name text);
    CREATE TABLE public.locations (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.cycles (id uuid PRIMARY KEY, name text, owner_id uuid, owner_type text, status text, type text,
      settings jsonb, start_date date, end_date date, price_per_session numeric, location_id uuid);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, start_time timestamptz, end_time timestamptz,
      max_participants int, is_public boolean, cyclus_id uuid, cyclus_name text, trainer_id uuid,
      price_per_session numeric, location_id uuid, academy_profile_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, status text,
      player_id uuid, guest_player_id uuid, payment_status text, paid_externally boolean, hold_expires_at timestamptz);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text);
    CREATE TABLE public.intake_requests (cycle_id uuid, player_id uuid, guest_player_id uuid, status text);

    INSERT INTO public.academy_profiles VALUES ('${ACAD}', 'Europe/Amsterdam');
    INSERT INTO public.trainer_profiles VALUES ('${TR}', gen_random_uuid());
    INSERT INTO public.cycles (id, name, owner_id, owner_type, status, type, settings) VALUES
      ('${CY}', 'Jeugd training', '${ACAD}', 'academy', 'open', 'cyclus', '{}'::jsonb);
    INSERT INTO public.availability_slots (id, start_time, end_time, max_participants, is_public, cyclus_id, trainer_id, academy_profile_id) VALUES
      ('70000000-0000-0000-0000-000000000004', '2999-01-01 10:00+00', '2999-01-01 11:00+00', 4, true, '${CY}', '${TR}', '${ACAD}');
  `);
  await db.exec(m('20260813100000_get_academy_cyclus_groups_academy_scope.sql'));
  await db.exec(m('20260816100000_academy_cyclus_groups_person_key.sql'));
  await db.exec(m('20260819100000_cyclus_groups_kind.sql'));
  await db.exec(m('20260820100000_cycle_categories.sql'));
});

describe('cycle categories', () => {
  it('the migration creates the catalog table with a manager RLS policy', async () => {
    const pol = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM pg_policies WHERE tablename = 'academy_cycle_categories'`);
    expect(Number(pol.rows[0].n)).toBeGreaterThan(0);
  });

  it('the RPC returns the assigned category name + color, null when uncategorized', async () => {
    expect((await catByCyclus())[CY]).toEqual({ name: null, color: null });

    await db.exec(`INSERT INTO public.academy_cycle_categories (id, academy_profile_id, name, color) VALUES ('${CAT}', '${ACAD}', 'Jeugd', 'green');`);
    await db.exec(`UPDATE public.cycles SET category_id = '${CAT}' WHERE id = '${CY}';`);
    expect((await catByCyclus())[CY]).toEqual({ name: 'Jeugd', color: 'green' });
  });

  it('UNIQUE(academy, name) rejects a duplicate category', async () => {
    await expect(
      db.query(`INSERT INTO public.academy_cycle_categories (academy_profile_id, name, color) VALUES ('${ACAD}', 'Jeugd', 'blue')`),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('deleting a category un-categorizes its cycles (FK ON DELETE SET NULL)', async () => {
    await db.exec(`DELETE FROM public.academy_cycle_categories WHERE id = '${CAT}';`);
    const row = (await db.query<{ category_id: string | null }>(`SELECT category_id FROM public.cycles WHERE id = '${CY}'`)).rows[0];
    expect(row.category_id).toBeNull();
    expect((await catByCyclus())[CY]).toEqual({ name: null, color: null });
  });
});
