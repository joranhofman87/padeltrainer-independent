// @vitest-environment node
// Phase 3.5d (migration 20260906100000): the two remaining small readers, person-keyed.
// - get_academy_cyclus_labels: FAM-02 name precedence (guest outranks profile on dual-keyed
//   rows), person dedup (a merged human appears once), frozen guest keys as its own person.
// - get_player_locations: the passed GUEST ref expands to the person's IN-SCOPE,
//   non-frozen guest refs (multi-guest persons' clubs no longer dropped); the PROFILE
//   side is deliberately NOT expanded (I-22 — callers pass the tenant-authorized ref
//   from get_person_refs_for_scope); dismissals under ANY ref hide the club.
// Runs the REAL migration file. These fns had NO prior coverage (TEST_COVERAGE_GAPS).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACADEMY = '90000000-0000-0000-0000-000000000001';
const MGR_U = 'b0000000-0000-0000-0000-0000000000a1';
const CYC = 'c0000000-0000-0000-0000-000000000001';
const SLOT = '50000000-0000-0000-0000-000000000001';
const LOC1 = '10000000-0000-0000-0000-000000000001';
const LOC2 = '10000000-0000-0000-0000-000000000002';
// merged person "Anna": profile PA + guests GA1, GA2
const PA = 'a0000000-0000-0000-0000-000000000001';
const GA1 = '70000000-0000-0000-0000-000000000001';
const GA2 = '70000000-0000-0000-0000-000000000002';
const PERSON_A = 'e0000000-0000-0000-0000-000000000001';
// frozen guest "Fred" linked to person A (different name on the guest row)
const GF = '70000000-0000-0000-0000-000000000003';

const labels = async (): Promise<Array<{ cycle_id: string; first_names: string[] }>> => {
  await db.exec(`SET test.uid = '${MGR_U}';`);
  const rows = (await db.query<{ cycle_id: string; first_names: string[] }>(
    `SELECT cycle_id, first_names FROM public.get_academy_cyclus_labels($1)`, [ACADEMY])).rows;
  await db.exec(`SET test.uid = '';`);
  return rows;
};

const locations = async (profile: string | null, guest: string | null): Promise<string[]> => {
  await db.exec(`SET test.uid = '${MGR_U}';`);
  const rows = (await db.query<{ location_name: string }>(
    `SELECT location_name FROM public.get_player_locations($1, $2, $3)`, [ACADEMY, profile, guest])).rows;
  await db.exec(`SET test.uid = '';`);
  return rows.map((r) => r.location_name).sort();
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon;

    CREATE TABLE public.cycles (id uuid PRIMARY KEY, owner_type text, owner_id uuid, type text, location_id uuid);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, cyclus_id uuid, start_time timestamptz, location_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, player_id uuid, guest_player_id uuid, person_id uuid, status text);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, first_name text, full_name text, preferred_location_id uuid, academy_profile_id uuid, trainer_id uuid);
    CREATE TABLE public.persons (id uuid PRIMARY KEY, full_name text);
    CREATE TABLE public.person_links (person_id uuid, profile_id uuid UNIQUE, guest_player_id uuid UNIQUE);
    CREATE TABLE public.person_merge_review (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text, status text, guest_player_id uuid);
    CREATE TABLE public.locations (id uuid PRIMARY KEY, name text, merged_into uuid);
    CREATE TABLE public.academy_locations (academy_profile_id uuid, location_id uuid, is_active boolean);
    CREATE TABLE public.academy_player_metadata (academy_profile_id uuid, profile_id uuid, guest_player_id uuid, preferred_location_id uuid);
    CREATE TABLE public.intake_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), player_id uuid, guest_player_id uuid, location_id uuid);
    CREATE TABLE public.academy_player_locations (academy_profile_id uuid, profile_id uuid, guest_player_id uuid, location_id uuid, dismissed boolean);
    CREATE TABLE public.academy_managers (user_id uuid, academy_profile_id uuid);
    CREATE TABLE public.academy_trainers (trainer_profile_id uuid, academy_profile_id uuid, status text);

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
    join(process.cwd(), 'supabase', 'migrations', '20260906100000_phase35d_small_readers_person.sql'), 'utf8'));
  await db.exec(`
    INSERT INTO public.academy_managers VALUES ('${MGR_U}', '${ACADEMY}');
    INSERT INTO public.cycles VALUES ('${CYC}', 'academy', '${ACADEMY}', 'cyclus', NULL);
    INSERT INTO public.locations (id, name) VALUES ('${LOC1}', 'Club Noord'), ('${LOC2}', 'Club Zuid');
    INSERT INTO public.availability_slots VALUES ('${SLOT}', '${CYC}', '2026-09-01T10:00:00Z', '${LOC1}');
    INSERT INTO public.academy_locations VALUES ('${ACADEMY}', '${LOC1}', true), ('${ACADEMY}', '${LOC2}', true);
    INSERT INTO public.profiles VALUES ('${PA}', 'Anna Profile');
    INSERT INTO public.guest_players (id, first_name, full_name, academy_profile_id) VALUES
      ('${GA1}', 'Anna', 'Anna Guest', '${ACADEMY}'), ('${GA2}', 'Anna', 'Anna Tweede', '${ACADEMY}'), ('${GF}', 'Fred', 'Fred Frozen', '${ACADEMY}');
    INSERT INTO public.persons VALUES ('${PERSON_A}', 'Anna Person');
    INSERT INTO public.person_links (person_id, profile_id, guest_player_id) VALUES
      ('${PERSON_A}', '${PA}', NULL), ('${PERSON_A}', NULL, '${GA1}'),
      ('${PERSON_A}', NULL, '${GA2}'), ('${PERSON_A}', NULL, '${GF}');
    INSERT INTO public.person_merge_review (kind, status, guest_player_id)
      VALUES ('twin_detached_needs_split', 'pending', '${GF}');
  `);
});

describe('get_academy_cyclus_labels (Phase 3.5d)', () => {
  it('a merged person seated under BOTH keys appears ONCE, with the person name', async () => {
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, person_id, status) VALUES ($1, $2, $3, 'confirmed')`, [SLOT, PA, PERSON_A]);
    await db.query(`INSERT INTO public.bookings (slot_id, guest_player_id, person_id, status) VALUES ($1, $2, $3, 'confirmed')`, [SLOT, GA1, PERSON_A]);
    const rows = await labels();
    expect(rows[0].first_names).toEqual(['Anna']);
    await db.exec(`DELETE FROM public.bookings`);
  });

  it('FAM-02: on a dual-keyed UNSTAMPED row the GUEST name outranks the profile name', async () => {
    await db.query(`INSERT INTO public.profiles VALUES ('a0000000-0000-0000-0000-000000000009', 'Piet Profiel')`);
    await db.query(`INSERT INTO public.guest_players (id, first_name) VALUES ('70000000-0000-0000-0000-000000000009', 'Gijs')`);
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status)
      VALUES ($1, 'a0000000-0000-0000-0000-000000000009', '70000000-0000-0000-0000-000000000009', 'confirmed')`, [SLOT]);
    const rows = await labels();
    expect(rows[0].first_names).toEqual(['Gijs']);
    await db.exec(`DELETE FROM public.bookings`);
  });

  it('a FROZEN guest keys as its own person and shows the GUEST name, not the person name', async () => {
    await db.query(`INSERT INTO public.bookings (slot_id, guest_player_id, person_id, status) VALUES ($1, $2, $3, 'confirmed')`, [SLOT, GF, PERSON_A]);
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, person_id, status) VALUES ($1, $2, $3, 'confirmed')`, [SLOT, PA, PERSON_A]);
    const rows = await labels();
    // Fred (frozen, own person) + Anna (the real person) — two chips.
    expect(rows[0].first_names).toEqual(['Anna', 'Fred']);
    await db.exec(`DELETE FROM public.bookings`);
  });
});

describe('get_academy_cyclus_labels location precedence', () => {
  it('cycle-level location outranks the earliest slot location (original order preserved)', async () => {
    await db.query(`UPDATE public.cycles SET location_id = $1 WHERE id = $2`, [LOC2, CYC]);
    await db.exec(`SET test.uid = '${MGR_U}';`);
    const rows = (await db.query<{ cycle_id: string; location_name: string }>(
      `SELECT cycle_id, location_name FROM public.get_academy_cyclus_labels($1)`, [ACADEMY])).rows;
    await db.exec(`SET test.uid = '';`);
    expect(rows[0].location_name).toBe('Club Zuid'); // cyc.location_id wins over slot LOC1
    await db.query(`UPDATE public.cycles SET location_id = NULL WHERE id = $1`, [CYC]);
  });
});

describe('get_player_locations (Phase 3.5d)', () => {
  it('THE FIX: clubs from the person\'s OTHER refs are included (multi-guest person)', async () => {
    // GA2 (a ref the caller did NOT pass) has a preferred location.
    await db.query(`UPDATE public.guest_players SET preferred_location_id = $1 WHERE id = $2`, [LOC2, GA2]);
    // Caller passes only the profile ref → LOC2 must still appear via the expansion.
    expect(await locations(PA, null)).toEqual(['Club Zuid']);
    await db.query(`UPDATE public.guest_players SET preferred_location_id = NULL WHERE id = $1`, [GA2]);
  });

  it('a FROZEN passed guest degrades to the single-pair read (no expansion)', async () => {
    await db.query(`UPDATE public.guest_players SET preferred_location_id = $1 WHERE id = $2`, [LOC2, GA2]);
    // GF is frozen: passing it must NOT expand to the person's other refs.
    expect(await locations(null, GF)).toEqual([]);
    await db.query(`UPDATE public.guest_players SET preferred_location_id = NULL WHERE id = $1`, [GA2]);
  });

  it('a dismissal under ANY of the person\'s refs hides the club', async () => {
    await db.query(`UPDATE public.guest_players SET preferred_location_id = $1 WHERE id = $2`, [LOC2, GA2]);
    // Dismissed under the PROFILE ref, while the club came from the GA2 ref.
    await db.query(`INSERT INTO public.academy_player_locations VALUES ($1, $2, NULL, $3, true)`, [ACADEMY, PA, LOC2]);
    expect(await locations(PA, null)).toEqual([]);
    await db.exec(`DELETE FROM public.academy_player_locations`);
    await db.query(`UPDATE public.guest_players SET preferred_location_id = NULL WHERE id = $1`, [GA2]);
  });

  it('CROSS-TENANT (verify r2 P1): a guest at ANOTHER academy is NOT expanded — no location leak', async () => {
    const GB = '70000000-0000-0000-0000-0000000000b1';
    const OTHER_ACADEMY = '90000000-0000-0000-0000-000000000009';
    await db.query(`INSERT INTO public.guest_players (id, academy_profile_id, preferred_location_id) VALUES ($1, $2, $3)`, [GB, OTHER_ACADEMY, LOC2]);
    await db.query(`INSERT INTO public.person_links (person_id, guest_player_id) VALUES ($1, $2)`, ['e0000000-0000-0000-0000-000000000001', GB]);
    // GB (other tenant) prefers LOC2 — must NOT surface on THIS academy's page via the expansion.
    expect(await locations(PA, null)).toEqual([]);
    await db.query(`DELETE FROM public.person_links WHERE guest_player_id = $1`, [GB]);
    await db.query(`DELETE FROM public.guest_players WHERE id = $1`, [GB]);
  });

  it('CROSS-TENANT (Codex P1): the PROFILE side is not expanded — another academy\'s pure-profile booking cannot leak in via a guest-opened page', async () => {
    // Caller opens the detail page via the GUEST ref only; the person's PROFILE has a
    // pure-profile booking at ANOTHER academy's slot at a club this academy also lists.
    const OTHER_TR = '30000000-0000-0000-0000-000000000009';
    const OTHER_SLOT = '50000000-0000-0000-0000-000000000009';
    await db.query(`INSERT INTO public.availability_slots VALUES ($1, NULL, '2026-09-03T10:00:00Z', $2)`, [OTHER_SLOT, LOC2]);
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, status) VALUES ($1, $2, 'confirmed')`, [OTHER_SLOT, PA]);
    expect(await locations(null, GA1)).toEqual([]); // profile ref NOT expanded from the guest
    await db.exec(`DELETE FROM public.bookings`);
    void OTHER_TR;
  });

  it('FAM-02: a dual-keyed booking does not credit the profile arm', async () => {
    const SLOT2 = '50000000-0000-0000-0000-000000000002';
    await db.query(`INSERT INTO public.availability_slots VALUES ($1, '${CYC}', '2026-09-02T10:00:00Z', $2)`, [SLOT2, LOC2]);
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status) VALUES ($1, $2, '70000000-0000-0000-0000-000000000009', 'confirmed')`, [SLOT2, PA])
      .catch(async () => { /* guest 09 may not exist */ });
    // dual-keyed (profile PA + an out-of-set guest): profile arm must NOT credit LOC2
    const locs = await locations(PA, null);
    expect(locs).toEqual([]);
    await db.exec(`DELETE FROM public.bookings`);
  });

  it('unauthorized caller is refused', async () => {
    await db.exec(`SET test.uid = 'b0000000-0000-0000-0000-000000000099';`);
    const denied = await db.query(`SELECT * FROM public.get_player_locations($1, $2, NULL)`, [ACADEMY, PA])
      .then(() => false, () => true);
    await db.exec(`SET test.uid = '';`);
    expect(denied).toBe(true);
  });
});
