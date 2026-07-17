// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Cycle-detail roster fix: a registered (profile-keyed) player who booked a cycle as a logged-in
// account was silently dropped from the academy cycle-detail roster because an academy manager
// cannot read their `profiles` row under RLS. get_cycle_roster_names resolves names via SECURITY
// DEFINER so BOTH profile and guest people surface. Runs the REAL migration and proves:
//   * an authorized academy manager gets the registered player's name (the RL Padel bug) + guests;
//   * the auth gate rejects a manager of a DIFFERENT academy.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACADEMY = 'aa000000-0000-0000-0000-000000000001';
const MGR_USER = 'aa000000-0000-0000-0000-0000000000a0'; // manages ACADEMY
const OTHER_USER = 'bb000000-0000-0000-0000-0000000000b0'; // manages a different academy
const OTHER_ACAD = 'bb000000-0000-0000-0000-000000000001';
const CYCLE = 'cc000000-0000-0000-0000-000000000001';
const SLOT = 'cc000000-0000-0000-0000-000000000051';
const REG_PROFILE = 'dd000000-0000-0000-0000-000000000001'; // registered player (the hidden one)
const GUEST = 'dd000000-0000-0000-0000-000000000002';

async function asUser<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET test.uid = '${uid}'; SET ROLE authenticated;`);
  try { return await fn(); } finally { await db.exec(`RESET ROLE; SET test.uid = '';`); }
}
const namesFor = async (uid: string, cycle: string): Promise<string[]> =>
  asUser(uid, async () => {
    const { rows } = await db.query<{ full_name: string }>(
      `SELECT full_name FROM public.get_cycle_roster_names($1) ORDER BY full_name`, [cycle],
    );
    return rows.map((r) => r.full_name);
  });
const failed = async (p: Promise<unknown>): Promise<boolean> => p.then(() => false, () => true);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;

    CREATE TABLE public.cycles (id uuid PRIMARY KEY, owner_type text, owner_id uuid);
    CREATE TABLE public.academy_managers (academy_profile_id uuid, user_id uuid);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text, user_id uuid);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, full_name text);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, cyclus_id uuid, academy_profile_id uuid, trainer_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, guest_player_id uuid, person_id uuid);
    -- Phase 3.1 deps: the person-keyed arm + get_my_person_id (created by the same migration)
    CREATE TABLE public.persons (id uuid PRIMARY KEY, full_name text);
    CREATE TABLE public.person_links (person_id uuid, profile_id uuid, guest_player_id uuid);
    CREATE OR REPLACE FUNCTION public.get_profile_id_for_user(_u uuid) RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT id FROM public.profiles WHERE user_id = _u LIMIT 1 $fn$;

    -- Prod-shaped helpers the RPC's auth gate reuses.
    CREATE OR REPLACE FUNCTION public.is_admin(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;
    CREATE OR REPLACE FUNCTION public.get_user_academy_ids(_u uuid) RETURNS SETOF uuid LANGUAGE sql STABLE
      SECURITY DEFINER SET search_path = public AS $fn$
        SELECT academy_profile_id FROM public.academy_managers WHERE user_id = _u $fn$;
    CREATE OR REPLACE FUNCTION public.get_user_club_ids(_u uuid) RETURNS SETOF uuid LANGUAGE sql STABLE AS $fn$
      SELECT NULL::uuid WHERE false $fn$;

    INSERT INTO public.cycles (id, owner_type, owner_id) VALUES ('${CYCLE}', 'academy', '${ACADEMY}');
    INSERT INTO public.academy_managers (academy_profile_id, user_id) VALUES
      ('${ACADEMY}', '${MGR_USER}'), ('${OTHER_ACAD}', '${OTHER_USER}');
    INSERT INTO public.profiles (id, full_name) VALUES ('${REG_PROFILE}', 'Mark Jan Alewijn');
    INSERT INTO public.guest_players (id, full_name) VALUES ('${GUEST}', 'Yente Heijnneman');
    INSERT INTO public.availability_slots (id, cyclus_id, academy_profile_id) VALUES ('${SLOT}', '${CYCLE}', '${ACADEMY}');
    -- The registered player booked as a logged-in account (player_id, no guest row) + one guest.
    INSERT INTO public.bookings (slot_id, player_id, guest_player_id) VALUES
      ('${SLOT}', '${REG_PROFILE}', NULL),
      ('${SLOT}', NULL, '${GUEST}');
  `);
  for (const file of [
    '20260826180000_get_cycle_roster_names.sql',
    '20260826290000_phase31_person_display_readers.sql', // the Phase 3.1 re-emit (person arm)
  ]) {
    await db.exec(
      readFileSync(join(process.cwd(), 'supabase', 'migrations', file), 'utf8')
        .split('\n').filter((l) => !/^(REVOKE|GRANT)\b/.test(l)).join('\n'),
    );
  }
  await db.exec(`GRANT EXECUTE ON FUNCTION public.get_cycle_roster_names(uuid) TO authenticated;`);
});

describe('get_cycle_roster_names', () => {
  it("returns the registered player's name (the hidden one) AND the guest, to the cycle's academy manager", async () => {
    expect(await namesFor(MGR_USER, CYCLE)).toEqual(['Mark Jan Alewijn', 'Yente Heijnneman']);
  });

  it("rejects a manager of a DIFFERENT academy (auth gate)", async () => {
    expect(await failed(namesFor(OTHER_USER, CYCLE))).toBe(true);
  });
});

describe('get_cycle_roster_names — Phase 3.1 person arm', () => {
  it('returns the PERSON-keyed name for a merged human (person id absent from both old arms)', async () => {
    // A merged twin: guest-keyed booking whose person id = the PROFILE's id. The profile arm
    // cannot emit it (no player_id booking) and the guest arm emits the guest id — only the
    // person arm names the person id the roster now groups by.
    const PERSON = 'ee000000-0000-0000-0000-000000000001';
    const MERGED_GUEST = 'ee000000-0000-0000-0000-000000000002';
    await db.exec(`
      INSERT INTO public.persons (id, full_name) VALUES ('${PERSON}', 'Mark Jan Alewijn');
      INSERT INTO public.guest_players (id, full_name) VALUES ('${MERGED_GUEST}', 'Mark Jan (guest)');
      INSERT INTO public.bookings (slot_id, guest_player_id, person_id) VALUES
        ('${SLOT}', '${MERGED_GUEST}', '${PERSON}');
    `);
    const rows = await asUser(MGR_USER, async () => {
      const { rows } = await db.query<{ id: string; full_name: string }>(
        `SELECT id, full_name FROM public.get_cycle_roster_names($1)`, [CYCLE],
      );
      return rows;
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.full_name]));
    expect(byId[PERSON]).toBe('Mark Jan Alewijn');      // the person-keyed arm
    expect(byId[MERGED_GUEST]).toBe('Mark Jan (guest)'); // old guest arm still present (fallback)
  });

  it('the person arm is cycle-scoped and the person name OUTRANKS a drifted profile name', async () => {
    // cross-cycle negative: a person-stamped booking on ANOTHER cycle must not leak in
    const OTHER_CYCLE = 'ff000000-0000-0000-0000-000000000001';
    const OTHER_SLOT = 'ff000000-0000-0000-0000-000000000051';
    const OTHER_PERSON = 'ff000000-0000-0000-0000-000000000002';
    await db.exec(`
      INSERT INTO public.cycles (id, owner_type, owner_id) VALUES ('${OTHER_CYCLE}', 'academy', '${ACADEMY}');
      INSERT INTO public.availability_slots (id, cyclus_id, academy_profile_id) VALUES ('${OTHER_SLOT}', '${OTHER_CYCLE}', '${ACADEMY}');
      INSERT INTO public.persons (id, full_name) VALUES ('${OTHER_PERSON}', 'Elders Iemand');
      INSERT INTO public.bookings (slot_id, guest_player_id, person_id) VALUES ('${OTHER_SLOT}', NULL, '${OTHER_PERSON}');
      -- name drift: the registered player's PERSON row (id = profile id) carries a fresher name
      INSERT INTO public.persons (id, full_name) VALUES ('${REG_PROFILE}', 'Mark Jan (persoon)');
      INSERT INTO public.bookings (slot_id, player_id, person_id) VALUES ('${SLOT}', '${REG_PROFILE}', '${REG_PROFILE}');
    `);
    const rows = await asUser(MGR_USER, async () => {
      const { rows } = await db.query<{ id: string; full_name: string }>(
        `SELECT id, full_name FROM public.get_cycle_roster_names($1)`, [CYCLE],
      );
      return rows;
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.full_name]));
    expect(byId[OTHER_PERSON]).toBeUndefined();          // cycle-scoped
    expect(byId[REG_PROFILE]).toBe('Mark Jan (persoon)'); // person arm (rank 1) wins over the profile arm
    const dupes = rows.filter((r) => r.id === REG_PROFILE);
    expect(dupes).toHaveLength(1);                        // DISTINCT ON — one row per id
  });
});
