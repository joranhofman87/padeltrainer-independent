// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// get_academy_cyclus_groups.kind (migration 20260819100000): a first-class Type axis for the
// cycle overview — 'rebook' (round, born type='cyclus' + rebook settings) / 'registration' /
// 'event' / 'cyclus' — so the overview separates the summer rebook flood from plain cycli.
// Runs the REAL migration chain against Postgres.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACAD = '50000000-0000-0000-0000-0000000000a0';
const MGR_UID = '50000000-0000-0000-0000-0000000000e0';
const TR = '50000000-0000-0000-0000-000000001001';

const m = (f: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8');
const kindByCyclus = async (): Promise<Record<string, string>> => {
  const { rows } = await db.query<{ cyclus_id: string; kind: string }>(
    `SELECT cyclus_id, kind FROM public.get_academy_cyclus_groups($1::uuid)`, [ACAD]);
  return Object.fromEntries(rows.map((r) => [r.cyclus_id, r.kind]));
};

// One cycle per kind. `R` = rebook, `RG` = registration, `EV` = event, `CY` = training cyclus,
// `NS` = a no-slot rebook cycle (exercises the UNION ALL branch's kind derivation).
const R = '60000000-0000-0000-0000-000000000001';
const RG = '60000000-0000-0000-0000-000000000002';
const EV = '60000000-0000-0000-0000-000000000003';
const CY = '60000000-0000-0000-0000-000000000004';
const NS = '60000000-0000-0000-0000-000000000005';

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
      ('${R}',  'Najaar herboeking', '${ACAD}', 'academy', 'open', 'cyclus', '{"rebook_payment_mode":"upfront","rebook_round_id":"r1"}'::jsonb),
      ('${RG}', 'Inschrijving',      '${ACAD}', 'academy', 'open', 'registration', '{}'::jsonb),
      ('${EV}', 'Toernooi',          '${ACAD}', 'academy', 'open', 'event', '{}'::jsonb),
      ('${CY}', 'Training',          '${ACAD}', 'academy', 'open', 'cyclus', '{}'::jsonb),
      ('${NS}', 'Herboeking leeg',   '${ACAD}', 'academy', 'open', 'cyclus', '{"rebook_round_id":"r2"}'::jsonb);
    -- one slot each for R/RG/EV/CY; NS has no slots (UNION ALL branch).
    INSERT INTO public.availability_slots (id, start_time, end_time, max_participants, is_public, cyclus_id, trainer_id, academy_profile_id) VALUES
      ('70000000-0000-0000-0000-000000000001', '2999-01-01 10:00+00', '2999-01-01 11:00+00', 4, true, '${R}',  '${TR}', '${ACAD}'),
      ('70000000-0000-0000-0000-000000000002', '2999-01-01 10:00+00', '2999-01-01 11:00+00', 4, true, '${RG}', '${TR}', '${ACAD}'),
      ('70000000-0000-0000-0000-000000000003', '2999-01-01 10:00+00', '2999-01-01 11:00+00', 4, true, '${EV}', '${TR}', '${ACAD}'),
      ('70000000-0000-0000-0000-000000000004', '2999-01-01 10:00+00', '2999-01-01 11:00+00', 4, true, '${CY}', '${TR}', '${ACAD}');
  `);
  // Replace-on-top: academy-scope → person-key → kind.
  await db.exec(m('20260813100000_get_academy_cyclus_groups_academy_scope.sql'));
  await db.exec(m('20260816100000_academy_cyclus_groups_person_key.sql'));
  await db.exec(m('20260819100000_cyclus_groups_kind.sql'));
});

describe('get_academy_cyclus_groups — kind', () => {
  it('classifies rebook / registration / event / cyclus, incl. a no-slot rebook via the UNION branch', async () => {
    const k = await kindByCyclus();
    expect(k[R]).toBe('rebook');       // type='cyclus' but rebook settings win
    expect(k[RG]).toBe('registration');
    expect(k[EV]).toBe('event');
    expect(k[CY]).toBe('cyclus');
    expect(k[NS]).toBe('rebook');      // no-slot cycle, rebook_round_id set → UNION branch derives rebook
  });

  it('IDOR gate still refuses another academy', async () => {
    await expect(
      db.query(`SELECT * FROM public.get_academy_cyclus_groups('99999999-9999-9999-9999-999999999999'::uuid)`),
    ).rejects.toThrow(/not_authorized_for_academy/);
  });
});
