// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// P2-2 regression: runs the ACTUAL migration SQL against real Postgres via PGlite and
// proves (a) the academy-manager guest_players SELECT predicate is scoped to guests with
// SOME relationship to the caller's academy (leak closed), and (b) the SECURITY DEFINER
// dedup RPC still surfaces trainer-owned candidates so email dedup does not create
// duplicate guests. Fails before the migration (functions absent -> query throws).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

function readMigration(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  return readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260706130100_p2_2_guest_players_academy_scope.sql'),
    'utf8',
  );
}

const ACAD = '40000000-0000-0000-0000-0000000000c0';
const OTHER_ACAD = '40000000-0000-0000-0000-0000000000c1';
const MGR = '50000000-0000-0000-0000-0000000000d0'; // manager user id (auth.uid())
const TRAINER_PROFILE = '70000000-0000-0000-0000-000000000001';
const OTHER_TRAINER = '70000000-0000-0000-0000-000000000002';
const ACAD_SLOT = '30000000-0000-0000-0000-0000000000e0';
const OTHER_SLOT = '30000000-0000-0000-0000-0000000000e1';

const G_DIRECT = '20000000-0000-0000-0000-000000000001'; // academy_profile_id = ACAD
const G_BOOKING = '20000000-0000-0000-0000-000000000002'; // booked on ACAD's slot
const G_META = '20000000-0000-0000-0000-000000000003'; // metadata link -> ACAD
const G_UNRELATED = '20000000-0000-0000-0000-000000000004'; // shared-trainer guest, NO academy relationship (leak)
const G_DEDUP_TRAINER = '20000000-0000-0000-0000-000000000005'; // trainer-owned, same email, dedup target
const G_DEDUP_OTHER = '20000000-0000-0000-0000-000000000006'; // same email but owned by an unrelated trainer

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE ROLE anon;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT '${MGR}'::uuid
    $fn$;

    CREATE TABLE public.academy_managers (user_id uuid, academy_profile_id uuid, role text);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.academy_trainers (academy_profile_id uuid, trainer_profile_id uuid, status text);
    CREATE TABLE public.guest_players (
      id uuid PRIMARY KEY, full_name text, email text DEFAULT '',
      academy_profile_id uuid, trainer_id uuid, created_at timestamptz DEFAULT now());
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, academy_profile_id uuid, trainer_id uuid);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid,
      guest_player_id uuid, player_id uuid, status text);
    CREATE TABLE public.academy_player_metadata (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      academy_profile_id uuid, guest_player_id uuid, profile_id uuid);

    -- get_user_academy_ids(_user_id): SETOF uuid from academy_managers (mirrors prod signature)
    CREATE OR REPLACE FUNCTION public.get_user_academy_ids(_user_id uuid)
    RETURNS SETOF uuid LANGUAGE sql STABLE AS $fn$
      SELECT academy_profile_id FROM public.academy_managers WHERE user_id = _user_id
    $fn$;
  `);

  // Apply the REAL migration under test.
  await db.exec(readMigration());

  await db.exec(`
    INSERT INTO public.academy_managers (user_id, academy_profile_id, role) VALUES ('${MGR}','${ACAD}','owner');
    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${TRAINER_PROFILE}','${MGR}'),('${OTHER_TRAINER}','${MGR}');
    INSERT INTO public.academy_trainers (academy_profile_id, trainer_profile_id, status) VALUES ('${ACAD}','${TRAINER_PROFILE}','active');
    INSERT INTO public.availability_slots (id, academy_profile_id, trainer_id) VALUES
      ('${ACAD_SLOT}','${ACAD}','${TRAINER_PROFILE}'),('${OTHER_SLOT}','${OTHER_ACAD}','${TRAINER_PROFILE}');

    -- (a) direct academy ownership
    INSERT INTO public.guest_players (id, full_name, academy_profile_id) VALUES ('${G_DIRECT}','Direct','${ACAD}');
    -- (b) booking on ACAD's slot; guest owned by the trainer, not the academy
    INSERT INTO public.guest_players (id, full_name, trainer_id) VALUES ('${G_BOOKING}','Booked','${TRAINER_PROFILE}');
    INSERT INTO public.bookings (slot_id, guest_player_id, status) VALUES ('${ACAD_SLOT}','${G_BOOKING}','confirmed');
    -- (c) metadata link to ACAD; guest owned by the trainer
    INSERT INTO public.guest_players (id, full_name, trainer_id) VALUES ('${G_META}','Meta','${TRAINER_PROFILE}');
    INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id) VALUES ('${ACAD}','${G_META}');
    -- (leak) shared-trainer guest with NO relationship to ACAD (only a booking on OTHER_ACAD's slot)
    INSERT INTO public.guest_players (id, full_name, trainer_id) VALUES ('${G_UNRELATED}','Unrelated','${TRAINER_PROFILE}');
    INSERT INTO public.bookings (slot_id, guest_player_id, status) VALUES ('${OTHER_SLOT}','${G_UNRELATED}','confirmed');

    -- dedup: a trainer-owned guest with an email; the academy resolve path must still find it
    INSERT INTO public.guest_players (id, full_name, email, trainer_id) VALUES ('${G_DEDUP_TRAINER}','Jane Doe','dup@test.com','${TRAINER_PROFILE}');
    -- same email but owned by an UNRELATED trainer (not in the academy's active set) -> must NOT be returned
    INSERT INTO public.guest_players (id, full_name, email, trainer_id) VALUES ('${G_DEDUP_OTHER}','Jane Doe','dup@test.com','${OTHER_TRAINER}');
  `);
});

async function belongs(guestId: string): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(
    `SELECT public.guest_belongs_to_user_academy($1, '${MGR}') AS ok`, [guestId]);
  return r.rows[0].ok;
}

describe('P2-2 guest_players academy SELECT scoping', () => {
  it('SEES a guest owned directly by the academy', async () => {
    expect(await belongs(G_DIRECT)).toBe(true);
  });
  it('SEES a guest booked on the academy\'s slot', async () => {
    expect(await belongs(G_BOOKING)).toBe(true);
  });
  // SUPERSEDED: this suite used to assert "SEES a guest linked via academy_player_metadata".
  // ABC-16 H0 (20261118110000_abc16_h0_metadata_authority_containment.sql) REMOVED that arm.
  // The overlay row is written by the caller, for a caller-chosen subject, so accepting it as
  // proof of the relationship let any authenticated user who created an academy mint read
  // access to an arbitrary guest's name, email, phone and billing details.
  //
  // The assertion is not simply inverted here: this file applies ONLY the P2-2 migration, so
  // an inverted expectation would describe a definition that main no longer has. The current
  // contract is proved against the FULL effective chain — including the attack it used to
  // allow — in src/test/abc16MetadataAuthority.pglite.test.ts.
  it('does NOT see an unrelated shared-trainer guest (the leak)', async () => {
    expect(await belongs(G_UNRELATED)).toBe(false);
  });

  it('dedup RPC still returns a trainer-owned guest by email (no duplicate created)', async () => {
    const r = await db.query<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM public.find_guest_players_by_email_for_academy('dup@test.com', '${ACAD}', ARRAY['${TRAINER_PROFILE}']::uuid[])`);
    const ids = r.rows.map((x) => x.id);
    expect(ids).toContain(G_DEDUP_TRAINER);
    // a same-email guest owned by an unrelated trainer (not passed) is excluded
    expect(ids).not.toContain(G_DEDUP_OTHER);
  });
});
