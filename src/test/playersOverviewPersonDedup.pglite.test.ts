// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Phase 3.2 (person-unification): the players overview + cyclus-groups list render PERSONS.
// Runs the REAL migration (20260827100000) against a minimal prod-shaped schema and proves:
//   * a merged human (profile + guest linked to one person) is ONE overview row carrying BOTH
//     keys, guest-preferred player_key, persons-table identity, player_type 'registered';
//   * unmerged guests/profiles render exactly as before (person_id = their own uuid);
//   * a SPLIT-FROZEN guest keys as itself → the pair stays TWO rows;
//   * FAM-02 activity attribution: a dual-keyed booking is the GUEST person's — an unmerged
//     parent profile no longer wears the child's activity (but stays listed, and keeps the
//     invoice ADDRESSEE exemption for overdue badges);
//   * metadata joins person-wide (tag union, guest-first metadata_id);
//   * a multi-guest person is one row whose activity matches through EITHER guest ref;
//   * get_academy_cyclus_groups roster names dedup by person (booked via guest seat AND own
//     profile in one group = ONE name), frozen pairs stay two.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACADEMY = 'aa000000-0000-0000-0000-000000000001';
const MGR_USER = 'aa000000-0000-0000-0000-0000000000a0';
const OTHER_USER = 'bb000000-0000-0000-0000-0000000000b0';
const TR1 = 'aa000000-0000-0000-0000-000000000071';
const TR1_USER = 'aa000000-0000-0000-0000-0000000000a7';
const LOC1 = 'aa000000-0000-0000-0000-00000000e001';
const CYCLE = 'cc000000-0000-0000-0000-000000000001';
const SLOT1 = 'cc000000-0000-0000-0000-000000000051';
const SLOT2 = 'cc000000-0000-0000-0000-000000000052';

// merged pair: guest GA + profile P1 → PERSON1 (deterministic: person id = profile id)
const GA = '10000000-0000-0000-0000-000000000001';
const P1 = '10000000-0000-0000-0000-000000000002';
const PERSON1 = P1;
// plain unmerged guest + plain registered profile
const GB = '20000000-0000-0000-0000-000000000001';
const P2 = '20000000-0000-0000-0000-000000000002';
// split-frozen pair: guest GC linked to P3's person, review pending
const GC = '30000000-0000-0000-0000-000000000001';
const P3 = '30000000-0000-0000-0000-000000000002';
const PERSON3 = P3;
// unmerged family: parent profile P5, child guest GF, dual-keyed booking
const P5 = '50000000-0000-0000-0000-000000000002';
const GF = '50000000-0000-0000-0000-000000000001';
// multi-guest person: guests GD + GE → PERSON4 (= GD, the older guest)
const GD = '40000000-0000-0000-0000-000000000001';
const GE = '40000000-0000-0000-0000-000000000002';
const PERSON4 = GD;

type OverviewRow = {
  player_key: string;
  player_type: string;
  guest_player_id: string | null;
  profile_id: string | null;
  person_id: string | null;
  full_name: string;
  email: string;
  skill_rating: string | number | null;
  metadata_id: string | null;
  tag_ids: string[] | null;
  academy_notes: string | null;
  trainer_ids: string[] | null;
  has_active_cyclus: boolean;
  has_overdue_payment: boolean;
  email_undeliverable: boolean;
  total_count: string | number;
};

async function overview(
  uid: string,
  opts: { search?: string; filters?: Record<string, unknown>; limit?: number; offset?: number } = {},
): Promise<OverviewRow[]> {
  await db.exec(`SET test.uid = '${uid}';`);
  try {
    const { rows } = await db.query<OverviewRow>(
      `SELECT * FROM public.get_players_overview('academy', $1, $2, $3::jsonb, 'name', 'asc', $4, $5)`,
      [ACADEMY, opts.search ?? null, JSON.stringify(opts.filters ?? {}), opts.limit ?? 50, opts.offset ?? 0],
    );
    return rows;
  } finally {
    await db.exec(`SET test.uid = '';`);
  }
}
const failed = async (p: Promise<unknown>): Promise<boolean> => p.then(() => false, () => true);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;

    -- ---- minimal prod-shaped tables (only the columns the two RPCs touch) ----
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY, timezone text);
    CREATE TABLE public.academy_managers (academy_profile_id uuid, user_id uuid);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.academy_trainers (academy_profile_id uuid, trainer_profile_id uuid, status text);
    CREATE TABLE public.profiles (
      id uuid PRIMARY KEY, user_id uuid, full_name text, email text, phone text,
      billing_business_name text, billing_address text, billing_btw_number text,
      skill_rating numeric, rating_system text, birth_date date);
    CREATE TABLE public.guest_players (
      id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid, full_name text, email text,
      phone text, billing_business_name text, billing_address text, billing_btw_number text,
      skill_rating numeric, rating_system text, notes text, source text, birth_date date,
      has_trained boolean, preferred_location_id uuid, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.persons (
      id uuid PRIMARY KEY, full_name text, email text, phone text, birth_date date,
      skill_rating numeric, rating_system text,
      billing_business_name text, billing_address text, billing_btw_number text);
    CREATE TABLE public.person_links (person_id uuid, profile_id uuid, guest_player_id uuid);
    CREATE TABLE public.person_merge_review (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text, status text,
      guest_player_id uuid, person_id uuid, email text);
    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid, location_id uuid,
      cyclus_id uuid, cyclus_name text, start_time timestamptz, end_time timestamptz,
      max_participants integer, is_public boolean, price_per_session numeric);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid,
      guest_player_id uuid, person_id uuid, status text, payment_status text,
      paid_externally boolean, hold_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.academy_player_metadata (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), academy_profile_id uuid, trainer_profile_id uuid,
      guest_player_id uuid, profile_id uuid, notes text, tag_ids uuid[],
      preferred_location_id uuid, removed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.intake_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cycle_id uuid, player_id uuid,
      guest_player_id uuid, location_id uuid, status text);
    CREATE TABLE public.academy_player_locations (
      academy_profile_id uuid, profile_id uuid, guest_player_id uuid, location_id uuid, dismissed boolean);
    CREATE TABLE public.locations (id uuid PRIMARY KEY, name text, merged_into uuid);
    CREATE TABLE public.academy_locations (academy_profile_id uuid, location_id uuid, is_active boolean);
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), academy_profile_id uuid, trainer_id uuid,
      player_id uuid, guest_player_id uuid, status text, due_date date, paid_at timestamptz);
    CREATE TABLE public.email_address_state (email text, state text);
    CREATE TABLE public.cycles (
      id uuid PRIMARY KEY, name text, owner_type text, owner_id uuid, status text, type text,
      start_date date, end_date date, price_per_session numeric, location_id uuid, category_id uuid,
      settings jsonb);
    CREATE TABLE public.academy_cycle_categories (id uuid PRIMARY KEY, name text, color text);

    -- ---- prod-shaped helper functions ----
    CREATE OR REPLACE FUNCTION public.is_academy_manager(_user_id uuid, _academy_profile_id uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT EXISTS (SELECT 1 FROM public.academy_managers
                       WHERE user_id = _user_id AND academy_profile_id = _academy_profile_id) $fn$;
    CREATE OR REPLACE FUNCTION public.get_user_academy_ids(_u uuid) RETURNS SETOF uuid LANGUAGE sql STABLE
      SECURITY DEFINER SET search_path = public AS $fn$
        SELECT academy_profile_id FROM public.academy_managers WHERE user_id = _u $fn$;
    -- fold_search_text / digits_only: verbatim prod definitions (20260611160000)
    CREATE OR REPLACE FUNCTION public.fold_search_text(_value text)
      RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS $fn$
        SELECT translate(lower(coalesce(_value, '')),
          'áàâäãåāăąçćčďđéèêëēĕėęěğģíìîïĩīĭįıķĺļľłñńņňóòôöõøōŏőŕŗřśšşťţúùûüũūŭůűųýÿžźż',
          'aaaaaaaaacccddeeeeeeeeeggiiiiiiiiikllllnnnnooooooooorrrsssttuuuuuuuuuuyyzzz') $fn$;
    CREATE OR REPLACE FUNCTION public.digits_only(_value text)
      RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS $fn$
        SELECT regexp_replace(coalesce(_value, ''), '\\D', '', 'g') $fn$;
    -- booking_occupies_seat: verbatim prod definition (20260816100000)
    CREATE OR REPLACE FUNCTION public.booking_occupies_seat(p_status text, p_hold_expires_at timestamptz)
      RETURNS boolean LANGUAGE sql STABLE AS $fn$
        SELECT COALESCE(p_status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
            OR (p_status = 'payment_pending' AND p_hold_expires_at IS NOT NULL AND p_hold_expires_at > now()) $fn$;
  `);

  // ---- fixtures ----
  await db.exec(`
    INSERT INTO public.academy_profiles (id, timezone) VALUES ('${ACADEMY}', 'Europe/Amsterdam');
    INSERT INTO public.academy_managers VALUES ('${ACADEMY}', '${MGR_USER}');
    INSERT INTO public.trainer_profiles VALUES ('${TR1}', '${TR1_USER}');
    INSERT INTO public.academy_trainers VALUES ('${ACADEMY}', '${TR1}', 'active');
    INSERT INTO public.locations (id, name) VALUES ('${LOC1}', 'Club Noord');
    INSERT INTO public.academy_locations VALUES ('${ACADEMY}', '${LOC1}', true);
    INSERT INTO public.cycles (id, name, owner_type, owner_id, status, type)
      VALUES ('${CYCLE}', 'Najaar', 'academy', '${ACADEMY}', 'active', 'cyclus');
    INSERT INTO public.availability_slots
      (id, trainer_id, academy_profile_id, location_id, cyclus_id, start_time, end_time, max_participants, is_public)
      VALUES
      ('${SLOT1}', '${TR1}', '${ACADEMY}', '${LOC1}', '${CYCLE}', now() + interval '1 day', now() + interval '1 day 1 hour', 4, false),
      ('${SLOT2}', '${TR1}', '${ACADEMY}', '${LOC1}', '${CYCLE}', now() + interval '8 days', now() + interval '8 days 1 hour', 4, false);

    -- merged pair: guest GA + profile P1 → PERSON1 (profile-first identity on the persons row)
    INSERT INTO public.guest_players (id, academy_profile_id, full_name, email, skill_rating, notes, source, has_trained)
      VALUES ('${GA}', '${ACADEMY}', 'Bram van laarhoven', 'bram@x.nl', 6.1, 'guest-side note', 'roster', true);
    INSERT INTO public.profiles (id, full_name, email, skill_rating)
      VALUES ('${P1}', 'Bram Van Laarhoven', 'bram@x.nl', 6.5);
    INSERT INTO public.persons (id, full_name, email, skill_rating)
      VALUES ('${PERSON1}', 'Bram Van Laarhoven', 'bram@x.nl', 6.5);
    INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PERSON1}', '${P1}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PERSON1}', '${GA}');
    -- the guest seat (dual-keyed, as the email-linker leaves it) + a pure-profile booking
    INSERT INTO public.bookings (slot_id, player_id, guest_player_id, person_id, status)
      VALUES ('${SLOT1}', '${P1}', '${GA}', '${PERSON1}', 'confirmed'),
             ('${SLOT2}', '${P1}', NULL, '${PERSON1}', 'confirmed');

    -- plain guest + plain registered profile (no links)
    INSERT INTO public.guest_players (id, academy_profile_id, full_name, email)
      VALUES ('${GB}', '${ACADEMY}', 'Plain Guest', 'gb@x.nl');
    INSERT INTO public.profiles (id, full_name, email) VALUES ('${P2}', 'Plain Registered', 'p2@x.nl');
    INSERT INTO public.bookings (slot_id, player_id, status) VALUES ('${SLOT1}', '${P2}', 'confirmed');

    -- split-frozen pair: GC linked to P3's person but a review is pending
    INSERT INTO public.guest_players (id, academy_profile_id, full_name, email)
      VALUES ('${GC}', '${ACADEMY}', 'Frozen Guest', 'family@x.nl');
    INSERT INTO public.profiles (id, full_name, email) VALUES ('${P3}', 'Frozen Profile', 'family@x.nl');
    INSERT INTO public.persons (id, full_name, email) VALUES ('${PERSON3}', 'Frozen Profile', 'family@x.nl');
    INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PERSON3}', '${P3}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PERSON3}', '${GC}');
    INSERT INTO public.person_merge_review (kind, status, guest_player_id, person_id)
      VALUES ('merged_guest_email_moved', 'pending', '${GC}', '${PERSON3}');
    INSERT INTO public.bookings (slot_id, player_id, status) VALUES ('${SLOT1}', '${P3}', 'confirmed');
    -- the frozen guest's OWN seat (stale stamp deliberately kept: readers must ignore it)
    INSERT INTO public.bookings (slot_id, guest_player_id, person_id, status)
      VALUES ('${SLOT1}', '${GC}', '${PERSON3}', 'confirmed');

    -- unmerged family: parent P5 + child guest GF, the parent's ONLY booking is dual-keyed
    INSERT INTO public.guest_players (id, academy_profile_id, full_name, email)
      VALUES ('${GF}', '${ACADEMY}', 'Child Guest', 'parent@x.nl');
    INSERT INTO public.profiles (id, full_name, email) VALUES ('${P5}', 'Parent Profile', 'parent@x.nl');
    INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status)
      VALUES ('${SLOT1}', '${P5}', '${GF}', 'confirmed');

    -- multi-guest person: GD (older) + GE, guest-only cluster → PERSON4 = GD
    INSERT INTO public.guest_players (id, academy_profile_id, full_name, email, created_at)
      VALUES ('${GD}', '${ACADEMY}', 'Adri  Govers', 'adri@x.nl', now() - interval '2 years'),
             ('${GE}', '${ACADEMY}', 'Adri Govers', 'adri@x.nl', now() - interval '1 year');
    INSERT INTO public.persons (id, full_name, email) VALUES ('${PERSON4}', 'Adri Govers', 'adri@x.nl');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PERSON4}', '${GD}'), ('${PERSON4}', '${GE}');
    -- only the SECOND guest has a booking — activity must match through either ref
    INSERT INTO public.bookings (slot_id, guest_player_id, person_id, status)
      VALUES ('${SLOT1}', '${GE}', '${PERSON4}', 'confirmed');
  `);

  // The migration under test — REAL file, only top-level GRANT/REVOKE stripped.
  await db.exec(
    readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260827100000_phase32_players_overview_person_dedup.sql'), 'utf8')
      .split('\n').filter((l) => !/^(REVOKE|GRANT)\b/.test(l)).join('\n'),
  );
});

describe('get_players_overview — one row per person (Phase 3.2)', () => {
  it('a merged human is ONE row: guest-preferred key, both ids, persons identity, registered type', async () => {
    const rows = await overview(MGR_USER);
    const bram = rows.filter((r) => r.email === 'bram@x.nl');
    expect(bram).toHaveLength(1);
    expect(bram[0].player_key).toBe(`g_${GA}`);
    expect(bram[0].guest_player_id).toBe(GA);
    expect(bram[0].profile_id).toBe(P1);
    expect(bram[0].person_id).toBe(PERSON1);
    expect(bram[0].player_type).toBe('registered');
    // identity from persons (the rederive choke point), not a per-side pick
    expect(bram[0].full_name).toBe('Bram Van Laarhoven');
    expect(Number(bram[0].skill_rating)).toBe(6.5);
  });

  it('unmerged guest + registered profile render exactly as before (person_id = own uuid)', async () => {
    const rows = await overview(MGR_USER);
    const gb = rows.find((r) => r.player_key === `g_${GB}`);
    const p2 = rows.find((r) => r.player_key === `p_${P2}`);
    expect(gb).toBeDefined();
    expect(gb!.person_id).toBe(GB);
    expect(gb!.player_type).toBe('guest');
    expect(gb!.profile_id).toBeNull();
    expect(p2).toBeDefined();
    expect(p2!.person_id).toBe(P2);
    expect(p2!.player_type).toBe('registered');
    expect(p2!.guest_player_id).toBeNull();
  });

  it('a SPLIT-FROZEN pair stays TWO rows, the guest as its own person with its own name', async () => {
    const rows = await overview(MGR_USER);
    const frozenGuest = rows.find((r) => r.player_key === `g_${GC}`);
    const frozenProfile = rows.find((r) => r.player_key === `p_${P3}`);
    expect(frozenGuest).toBeDefined();
    expect(frozenGuest!.person_id).toBe(GC); // link suspended → keys as itself
    expect(frozenGuest!.full_name).toBe('Frozen Guest');
    expect(frozenGuest!.profile_id).toBeNull();
    expect(frozenProfile).toBeDefined();
    expect(frozenProfile!.person_id).toBe(PERSON3);
  });

  it('FAM-02: a dual-keyed booking is the GUEST person\'s activity — the unmerged parent stays listed but bare', async () => {
    const rows = await overview(MGR_USER);
    const child = rows.find((r) => r.player_key === `g_${GF}`);
    const parent = rows.find((r) => r.player_key === `p_${P5}`);
    expect(child).toBeDefined();
    expect(child!.has_active_cyclus).toBe(true);
    expect(child!.trainer_ids).toEqual([TR1]);
    // membership deliberately unchanged: the parent is LISTED…
    expect(parent).toBeDefined();
    // …but wears none of the child's activity (pure-profile guard)
    expect(parent!.has_active_cyclus).toBe(false);
    expect(parent!.trainer_ids ?? []).toEqual([]);
  });

  it('invoice ADDRESSEE exemption: a dual-keyed overdue invoice badges parent AND child', async () => {
    await db.exec(`
      INSERT INTO public.invoices (academy_profile_id, player_id, guest_player_id, status, due_date)
      VALUES ('${ACADEMY}', '${P5}', '${GF}', 'overdue', current_date - 10);
    `);
    const rows = await overview(MGR_USER);
    expect(rows.find((r) => r.player_key === `p_${P5}`)!.has_overdue_payment).toBe(true);
    expect(rows.find((r) => r.player_key === `g_${GF}`)!.has_overdue_payment).toBe(true);
    await db.exec(`DELETE FROM public.invoices WHERE player_id = '${P5}';`);
  });

  it('a multi-guest person is ONE row whose activity matches through EITHER guest ref', async () => {
    const rows = await overview(MGR_USER);
    const adri = rows.filter((r) => r.email === 'adri@x.nl');
    expect(adri).toHaveLength(1);
    expect(adri[0].player_key).toBe(`g_${GD}`); // oldest guest is the primary ref
    expect(adri[0].person_id).toBe(PERSON4);
    expect(adri[0].full_name).toBe('Adri Govers'); // persons identity, not the double-space one
    expect(adri[0].has_active_cyclus).toBe(true); // the booking is on GE, the SECOND ref
    // trainer filter matches through the secondary ref too
    const filtered = await overview(MGR_USER, { filters: { trainer_id: TR1 } });
    expect(filtered.some((r) => r.person_id === PERSON4)).toBe(true);
  });

  it('metadata is ONE guest-first row: id + tags + notes from the SAME row (read = write target)', async () => {
    const TAG_A = '99000000-0000-0000-0000-00000000000a';
    const TAG_B = '99000000-0000-0000-0000-00000000000b';
    await db.exec(`
      INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, tag_ids, notes, created_at)
        VALUES ('${ACADEMY}', '${GA}', ARRAY['${TAG_A}']::uuid[], NULL, now() - interval '1 day');
      INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id, tag_ids, notes)
        VALUES ('${ACADEMY}', '${P1}', ARRAY['${TAG_B}']::uuid[], 'profile meta note');
    `);
    const rows = await overview(MGR_USER);
    const bram = rows.find((r) => r.person_id === PERSON1)!;
    // strictly the guest-side row — a union display would make the profile-side tag/notes
    // unremovable (edits via metadata_id write the guest row)
    expect(bram.tag_ids ?? []).toEqual([TAG_A]);
    expect(bram.academy_notes).toBeNull(); // NOT 'profile meta note' from the other row
    const metaRow = await db.query<{ id: string }>(
      `SELECT id FROM public.academy_player_metadata WHERE guest_player_id = '${GA}'`);
    expect(bram.metadata_id).toBe(metaRow.rows[0].id);
    // the tag filter sees exactly what the row displays
    expect((await overview(MGR_USER, { filters: { tag_id: TAG_A } })).some((r) => r.person_id === PERSON1)).toBe(true);
    expect((await overview(MGR_USER, { filters: { tag_id: TAG_B } })).some((r) => r.person_id === PERSON1)).toBe(false);
    await db.exec(`DELETE FROM public.academy_player_metadata WHERE guest_player_id = '${GA}' OR profile_id = '${P1}';`);
  });

  it('REMOVAL is person-level: removing one side of a merged person removes the human', async () => {
    await db.exec(`
      INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, removed_at)
        VALUES ('${ACADEMY}', '${GA}', now());
    `);
    const rows = await overview(MGR_USER);
    // no re-render under the profile side — the person is gone entirely
    expect(rows.some((r) => r.person_id === PERSON1)).toBe(false);
    expect(rows.some((r) => r.profile_id === P1)).toBe(false);
    await db.exec(`DELETE FROM public.academy_player_metadata WHERE guest_player_id = '${GA}';`);
  });

  it('the losing-side (guest) identity stays searchable and its email still flags deliverability', async () => {
    // give the guest side its own roster email, distinct from the displayed profile one
    await db.exec(`
      UPDATE public.guest_players SET email = 'roster-bram@club.nl' WHERE id = '${GA}';
      INSERT INTO public.email_address_state (email, state) VALUES ('roster-bram@club.nl', 'hard_bounced');
    `);
    // display = in-scope profile identity…
    const rows = await overview(MGR_USER);
    const bram = rows.find((r) => r.person_id === PERSON1)!;
    expect(bram.email).toBe('bram@x.nl');
    // …but the guest-side email still finds the person AND still badges delivery issues
    const bySideEmail = await overview(MGR_USER, { search: 'roster-bram' });
    expect(bySideEmail.some((r) => r.person_id === PERSON1)).toBe(true);
    expect(bram.email_undeliverable).toBe(true);
    await db.exec(`
      UPDATE public.guest_players SET email = 'bram@x.nl' WHERE id = '${GA}';
      DELETE FROM public.email_address_state WHERE email = 'roster-bram@club.nl';
    `);
  });

  it('a multi-guest person is filterable by EVERY owning trainer, not just the primary ref\'s', async () => {
    const TR2 = 'aa000000-0000-0000-0000-000000000072';
    const TR2_USER = 'aa000000-0000-0000-0000-0000000000a8';
    await db.exec(`
      INSERT INTO public.trainer_profiles VALUES ('${TR2}', '${TR2_USER}');
      INSERT INTO public.academy_trainers VALUES ('${ACADEMY}', '${TR2}', 'active');
      -- the SECONDARY guest (GE) is owned by TR2; GD (primary) stays academy-level
      UPDATE public.guest_players SET trainer_id = '${TR2}' WHERE id = '${GE}';
    `);
    const byTr2 = await overview(MGR_USER, { filters: { trainer_id: TR2 } });
    expect(byTr2.some((r) => r.person_id === PERSON4)).toBe(true);
    const row = (await overview(MGR_USER)).find((r) => r.person_id === PERSON4)!;
    expect(row.trainer_ids).toContain(TR2);
    await db.exec(`UPDATE public.guest_players SET trainer_id = NULL WHERE id = '${GE}';`);
  });

  it('total_count counts PERSONS and pagination stays stable', async () => {
    const all = await overview(MGR_USER);
    const keys = all.map((r) => r.player_key);
    expect(new Set(keys).size).toBe(keys.length); // one row per person, keys unique
    expect(Number(all[0].total_count)).toBe(all.length);
    const page0 = await overview(MGR_USER, { limit: 2, offset: 0 });
    const page1 = await overview(MGR_USER, { limit: 2, offset: 2 });
    expect(page0.map((r) => r.player_key).concat(page1.map((r) => r.player_key)))
      .toEqual(keys.slice(0, 4));
  });

  it('search matches the merged identity (persons name)', async () => {
    const rows = await overview(MGR_USER, { search: 'laarhoven' });
    expect(rows).toHaveLength(1);
    expect(rows[0].person_id).toBe(PERSON1);
  });

  it('rejects a non-manager (auth gate intact)', async () => {
    expect(await failed(overview(OTHER_USER))).toBe(true);
  });
});

describe('get_players_overview — contract carried forward onto the rewritten pipeline', () => {
  it('diacritic folding + phone-digit search still match', async () => {
    await db.exec(`
      INSERT INTO public.guest_players (id, academy_profile_id, full_name, email, phone)
      VALUES ('98000000-0000-0000-0000-000000000001', '${ACADEMY}', 'René Müller', 'rene@x.nl', '+31 6 1234 5678');
    `);
    expect((await overview(MGR_USER, { search: 'rené' })).some((r) => r.full_name === 'René Müller')).toBe(true);
    expect((await overview(MGR_USER, { search: 'muller' })).some((r) => r.full_name === 'René Müller')).toBe(true);
    expect((await overview(MGR_USER, { search: '612345' })).some((r) => r.full_name === 'René Müller')).toBe(true);
    await db.exec(`DELETE FROM public.guest_players WHERE id = '98000000-0000-0000-0000-000000000001';`);
  });

  it('level bands are half-open (gt, max] and unrated selects NULL ratings; merged uses profile-first skill', async () => {
    // PERSON1 merged skill = 6.5 (in-scope profile side outranks guest 6.1)
    const advanced = await overview(MGR_USER, { filters: { level_gt: 6, level_max: 9 } });
    expect(advanced.some((r) => r.person_id === PERSON1)).toBe(true);
    const intermediate = await overview(MGR_USER, { filters: { level_gt: 3, level_max: 6 } });
    expect(intermediate.some((r) => r.person_id === PERSON1)).toBe(false); // 6.5 > 6, and 6.1 must not leak
    const unrated = await overview(MGR_USER, { filters: { level_unrated: true } });
    expect(unrated.every((r) => r.skill_rating === null)).toBe(true);
    expect(unrated.some((r) => r.player_key === `g_${GB}`)).toBe(true);
  });

  it("tag 'untagged' matches persons without tags", async () => {
    const untagged = await overview(MGR_USER, { filters: { tag_id: 'untagged' } });
    expect(untagged.some((r) => r.player_key === `g_${GB}`)).toBe(true);
    expect(Number(untagged[0].total_count)).toBe(untagged.length);
  });

  it('the payment FILTER agrees with the badge (both invoice predicates, incl. the addressee exemption)', async () => {
    await db.exec(`
      INSERT INTO public.invoices (academy_profile_id, player_id, guest_player_id, status, due_date)
      VALUES ('${ACADEMY}', '${P5}', '${GF}', 'overdue', current_date - 10);
    `);
    const overdue = await overview(MGR_USER, { filters: { payment: 'overdue' } });
    expect(overdue.some((r) => r.player_key === `g_${GF}`)).toBe(true);
    expect(overdue.some((r) => r.player_key === `p_${P5}`)).toBe(true); // addressee exemption in the FILTER too
    const ok = await overview(MGR_USER, { filters: { payment: 'ok' } });
    expect(ok.some((r) => r.player_key === `g_${GF}`)).toBe(false);
    await db.exec(`DELETE FROM public.invoices WHERE player_id = '${P5}';`);
  });

  it('location filter + chips: merged person trained at the slot location; unmerged parent shows none', async () => {
    const byLoc = await overview(MGR_USER, { filters: { location_id: LOC1 } });
    expect(byLoc.some((r) => r.person_id === PERSON1)).toBe(true);
    const all = await overview(MGR_USER);
    const bram = all.find((r) => r.person_id === PERSON1)! as OverviewRow & { location_names: string[] };
    expect(bram.location_names).toEqual(['Club Noord']);
    // the parent's only booking is dual-keyed → the guard keeps the location off their row
    expect(byLoc.some((r) => r.player_key === `p_${P5}`)).toBe(false);
  });

  it('sort by skill desc puts the merged 6.5 first among rated rows', async () => {
    await db.exec(`SET test.uid = '${MGR_USER}';`);
    const { rows } = await db.query<{ person_id: string; skill_rating: string | null }>(
      `SELECT person_id, skill_rating FROM public.get_players_overview('academy', $1, NULL, '{}'::jsonb, 'skill', 'desc', 50, 0)`,
      [ACADEMY],
    );
    await db.exec(`SET test.uid = '';`);
    expect(rows[0].person_id).toBe(PERSON1);
  });
});

describe('get_players_overview — trainer scope', () => {
  const TGUEST = '60000000-0000-0000-0000-000000000001';
  const TP = '60000000-0000-0000-0000-000000000002';
  const trainerOverview = async () => {
    await db.exec(`SET test.uid = '${TR1_USER}';`);
    try {
      const { rows } = await db.query<OverviewRow>(
        `SELECT * FROM public.get_players_overview('trainer', $1)`, [TR1]);
      return rows;
    } finally {
      await db.exec(`SET test.uid = '';`);
    }
  };

  it('a trainer sees their own guests + registered bookers, merged pairs deduped', async () => {
    await db.exec(`
      INSERT INTO public.guest_players (id, trainer_id, full_name, email)
        VALUES ('${TGUEST}', '${TR1}', 'Trainer Guest', 'tg@x.nl');
      INSERT INTO public.profiles (id, full_name, email) VALUES ('${TP}', 'Trainer Registered', 'tp@x.nl');
      INSERT INTO public.persons (id, full_name, email) VALUES ('${TP}', 'Trainer Registered', 'tp@x.nl');
      INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${TP}', '${TGUEST}');
      INSERT INTO public.person_links (person_id, profile_id) VALUES ('${TP}', '${TP}');
      INSERT INTO public.bookings (slot_id, player_id, status) VALUES ('${SLOT1}', '${TP}', 'confirmed');
    `);
    const rows = await trainerOverview();
    const merged = rows.filter((r) => r.person_id === TP);
    expect(merged).toHaveLength(1);
    expect(merged[0].player_key).toBe(`g_${TGUEST}`);
    expect(merged[0].player_type).toBe('registered');
    // ACADEMY-scope guests that aren't the trainer's stay invisible in trainer scope
    expect(rows.some((r) => r.player_key === `g_${GB}`)).toBe(false);
  });

  it("rejects a user who isn't that trainer", async () => {
    await db.exec(`SET test.uid = '${MGR_USER}';`);
    const rejected = await failed(db.query(`SELECT * FROM public.get_players_overview('trainer', $1)`, [TR1]));
    await db.exec(`SET test.uid = '';`);
    expect(rejected).toBe(true);
  });
});

describe('get_academy_cyclus_groups — person-keyed roster names (Phase 3.2)', () => {
  const groups = async (uid: string) => {
    await db.exec(`SET test.uid = '${uid}';`);
    try {
      const { rows } = await db.query<{ cyclus_id: string; player_names: string[]; player_count: number }>(
        `SELECT cyclus_id, player_names, player_count FROM public.get_academy_cyclus_groups($1)`,
        [ACADEMY],
      );
      return rows;
    } finally {
      await db.exec(`SET test.uid = '';`);
    }
  };

  it('a merged human booked via guest seat AND own profile is ONE roster name (persons name)', async () => {
    const g = (await groups(MGR_USER)).find((r) => r.cyclus_id === CYCLE)!;
    // PERSON1 booked SLOT1 dual-keyed (guest seat) + SLOT2 pure-profile → one name
    expect(g.player_names.filter((n) => n === 'Bram Van Laarhoven')).toHaveLength(1);
    expect(g.player_names).not.toContain('Bram van laarhoven'); // guest-side spelling superseded
    // the frozen pair stays two: guest keys as itself, profile as its person
    expect(g.player_names).toContain('Frozen Guest');
    expect(g.player_names).toContain('Frozen Profile');
    // multi-guest person contributes one name via its secondary ref's booking
    expect(g.player_names.filter((n) => n === 'Adri Govers')).toHaveLength(1);
    expect(g.player_names).not.toContain('Adri  Govers');
  });

  it('an intake by the profile side dedups against a booking by the guest side (same person key)', async () => {
    // PERSON1 intakes via P1 (profile side) on the same cycle where the guest seat is booked —
    // before person keys these joined only by name EQUALITY; the differing spellings would have
    // shown twice. Now the KEY dedups them.
    await db.exec(`
      INSERT INTO public.intake_requests (cycle_id, player_id, status) VALUES ('${CYCLE}', '${P1}', 'confirmed');
    `);
    const g = (await groups(MGR_USER)).find((r) => r.cyclus_id === CYCLE)!;
    expect(g.player_names.filter((n) => n.startsWith('Bram'))).toHaveLength(1);
    await db.exec(`DELETE FROM public.intake_requests WHERE player_id = '${P1}';`);
  });

  it("an UNLINKED duplicate's intake still suppresses against a linked booking (side-name equality)", async () => {
    // G2 carries the guest-side spelling of PERSON1's booked seat. The booked row now DISPLAYS
    // the persons spelling ('Bram Van Laarhoven'), so name-only suppression would miss — the
    // kept side_name must still dedup the intake.
    const G2 = '70000000-0000-0000-0000-000000000001';
    await db.exec(`
      INSERT INTO public.guest_players (id, academy_profile_id, full_name)
        VALUES ('${G2}', '${ACADEMY}', 'Bram van laarhoven');
      INSERT INTO public.intake_requests (cycle_id, guest_player_id, status)
        VALUES ('${CYCLE}', '${G2}', 'pending');
    `);
    const g = (await groups(MGR_USER)).find((r) => r.cyclus_id === CYCLE)!;
    expect(g.player_names.filter((n) => n.toLowerCase().startsWith('bram'))).toHaveLength(1);
    await db.exec(`DELETE FROM public.intake_requests WHERE guest_player_id = '${G2}';
                   DELETE FROM public.guest_players WHERE id = '${G2}';`);
  });

  it('a FROZEN guest intake keys as itself and dedups against its own booking', async () => {
    await db.exec(`
      INSERT INTO public.intake_requests (cycle_id, guest_player_id, status)
        VALUES ('${CYCLE}', '${GC}', 'confirmed');
    `);
    const g = (await groups(MGR_USER)).find((r) => r.cyclus_id === CYCLE)!;
    expect(g.player_names.filter((n) => n === 'Frozen Guest')).toHaveLength(1); // not merged, not doubled
    await db.exec(`DELETE FROM public.intake_requests WHERE guest_player_id = '${GC}';`);
  });

  it('the no-slot cycle arm renders intake persons (person-keyed)', async () => {
    const CYCLE2 = 'cc000000-0000-0000-0000-000000000002';
    await db.exec(`
      INSERT INTO public.cycles (id, name, owner_type, owner_id, status, type)
        VALUES ('${CYCLE2}', 'Winter', 'academy', '${ACADEMY}', 'draft', 'cyclus');
      INSERT INTO public.intake_requests (cycle_id, player_id, status) VALUES ('${CYCLE2}', '${P1}', 'pending');
    `);
    const g = (await groups(MGR_USER)).find((r) => r.cyclus_id === CYCLE2)!;
    expect(g.player_names).toEqual(['Bram Van Laarhoven']); // persons name via the profile link
    await db.exec(`DELETE FROM public.intake_requests WHERE cycle_id = '${CYCLE2}';
                   DELETE FROM public.cycles WHERE id = '${CYCLE2}';`);
  });

  it('rejects a non-manager (auth gate intact)', async () => {
    await db.exec(`SET test.uid = '${OTHER_USER}';`);
    const rejected = await failed(db.query(`SELECT * FROM public.get_academy_cyclus_groups($1)`, [ACADEMY]));
    await db.exec(`SET test.uid = '';`);
    expect(rejected).toBe(true);
  });
});
