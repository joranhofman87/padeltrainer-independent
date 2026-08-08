/**
 * The shared U1a fixture universe: schema stubs + one fixture per terminal disposition and per
 * evidence path.
 *
 * Extracted so the U1a and U1b rehearsals seed from ONE definition. U1b's acceptance criterion is
 * that every U1a inventory path and taxonomy class has a fixture; satisfying that with a second,
 * hand-maintained copy would guarantee the two drift, and the drift would show up as U1b silently
 * covering fewer classes than it claims. One source, no drift.
 *
 * Contains no assertions — the rehearsals own those.
 */

/** Fixed identifiers: deterministic fixtures, no random UUIDs. */
export const id = (tag, n) => `${tag}${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`.slice(0, 36);

export const A1 = id('aaaa', 1);           // academy 1
export const A2 = id('aaaa', 2);           // academy 2 (isolation)
export const A_MISSING = id('aaaa', 9);    // referenced but absent → orphan
export const T1 = id('7777', 1);           // trainer with a DIRECT academy slot
export const T2 = id('7777', 2);           // active academy trainer with NO direct academy slot
export const T3 = id('7777', 3);           // NOT an academy trainer at all (personal slots only)
export const P = (n) => id('bbbb', n);     // profiles
export const G = (n) => id('cccc', n);     // guests
export const PE = (n) => id('dddd', n);    // persons
export const S = (n) => id('5555', n);     // slots
export const B = (n) => id('6666', n);     // bookings
export const M = (n) => id('8888', n);     // metadata rows
export const L = (n) => id('9999', n);     // location rows

/** The fixed snapshot parameter. Never now(): determinism is the point. */
export const AS_OF = '2026-08-08T00:00:00Z';

/**
 * Legacy schema stubs + the Supabase roles.
 *
 * The roles exist so the real migrations and the real seed deny-list can run VERBATIM. Stripping
 * grants instead (the tempting pglite shortcut) would make every ACL assertion vacuous.
 */
export const SCHEMA_STUB_SQL = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY);
  CREATE TABLE public.persons (id uuid PRIMARY KEY);
  CREATE TABLE public.guest_players (
    id uuid PRIMARY KEY, academy_profile_id uuid, trainer_id uuid,
    twin_of_profile_id uuid, linked_profile_id uuid,
    notes text, preferred_location_id uuid);
  CREATE TABLE public.person_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid NOT NULL,
    profile_id uuid UNIQUE, guest_player_id uuid UNIQUE);
  CREATE TABLE public.person_merge_review (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guest_player_id uuid, kind text, status text);
  CREATE TABLE public.academy_player_metadata (
    id uuid PRIMARY KEY, academy_profile_id uuid, trainer_profile_id uuid,
    guest_player_id uuid, profile_id uuid, person_id uuid,
    notes text, tag_ids uuid[] DEFAULT '{}', billing_email text,
    removed_at timestamptz, preferred_location_id uuid);
  CREATE TABLE public.academy_player_locations (
    id uuid PRIMARY KEY, academy_profile_id uuid NOT NULL, guest_player_id uuid, profile_id uuid,
    person_id uuid, location_id uuid, dismissed boolean NOT NULL DEFAULT false);
  CREATE TABLE public.availability_slots (
    id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid, cyclus_id uuid);
  CREATE TABLE public.bookings (
    id uuid PRIMARY KEY, slot_id uuid, player_id uuid, guest_player_id uuid,
    person_id uuid, status text);
  CREATE TABLE public.academy_trainers (
    academy_profile_id uuid, trainer_profile_id uuid, status text);
  CREATE TABLE public.cycles (id uuid PRIMARY KEY, owner_type text, owner_id uuid, type text);
  CREATE TABLE public.intake_requests (
    id uuid PRIMARY KEY, cycle_id uuid, player_id uuid, guest_player_id uuid, status text);
  CREATE TABLE public.academy_locations (academy_profile_id uuid, location_id uuid);
  CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
`;

/** One fixture per terminal disposition, plus the path-boundary and duplicate-taxonomy cases. */
export const FIXTURE_SQL = `
  INSERT INTO public.academy_profiles VALUES ('${A1}'), ('${A2}');
  INSERT INTO public.academy_trainers VALUES ('${A1}','${T1}','active'), ('${A1}','${T2}','active');
  INSERT INTO public.profiles  SELECT * FROM (VALUES ${[5, 7, 11, 12, 31, 34, 60].map((n) => `('${P(n)}'::uuid)`).join(',')}) v;
  INSERT INTO public.persons   SELECT * FROM (VALUES ${[1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 30, 31, 32, 33, 34, 40, 60, 61, 62].map((n) => `('${PE(n)}'::uuid)`).concat([`('${PE(55)}'::uuid)`, `('${PE(77)}'::uuid)`, `('${PE(99)}'::uuid)`]).join(',')}) v;

  -- 1 eligible: academy-owned guest with one clean metadata row
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(1)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(1)}','${G(1)}');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id, notes)
    VALUES ('${M(1)}','${A1}','${G(1)}','${PE(1)}','clean');

  -- 2 wrong-target academy FK: a location row whose "academy" is really a profiles row
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(2)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(99)}','${G(2)}');
  INSERT INTO public.academy_player_locations (id, academy_profile_id, guest_player_id, person_id)
    VALUES ('${L(2)}','${P(12)}','${G(2)}','${PE(99)}');

  -- 3 orphan reference: metadata row pointing at an academy that does not exist
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(3)}','${A_MISSING}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(3)}','${G(3)}');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id)
    VALUES ('${M(3)}','${A_MISSING}','${G(3)}','${PE(3)}');

  -- 4 missing person link: academy-owned guest with NO person_links row
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(4)}','${A1}');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id)
    VALUES ('${M(4)}','${A1}','${G(4)}');

  -- 5 split-frozen: pending twin_detached_needs_split
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(5)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(5)}','${G(5)}');
  INSERT INTO public.person_merge_review (guest_player_id, kind, status)
    VALUES ('${G(5)}','twin_detached_needs_split','pending');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id)
    VALUES ('${M(5)}','${A1}','${G(5)}','${PE(5)}');

  -- 6 divergent dual-key: overview resolves by player_id, FAM-02 guest-first → different persons
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(6)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(6)}','${G(6)}');
  INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PE(55)}','${P(5)}');
  INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id) VALUES ('${S(6)}','${T1}','${A1}');
  INSERT INTO public.bookings (id, slot_id, player_id, guest_player_id, status)
    VALUES ('${B(6)}','${S(6)}','${P(5)}','${G(6)}','confirmed');

  -- 7 stale person stamp: metadata.person_id disagrees with person_links
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(7)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(7)}','${G(7)}');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id)
    VALUES ('${M(7)}','${A1}','${G(7)}','${PE(77)}');

  -- 8 bridge divergent: twin_of_profile_id resolves to a different person than the guest link
  INSERT INTO public.guest_players (id, academy_profile_id, twin_of_profile_id)
    VALUES ('${G(8)}','${A1}','${P(7)}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(8)}','${G(8)}');
  INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PE(77)}','${P(7)}');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id)
    VALUES ('${M(8)}','${A1}','${G(8)}','${PE(8)}');

  -- 9 historical unique-email auto-merge (OD-09: reviewable, never newly-verified evidence)
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(9)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(9)}','${G(9)}');
  INSERT INTO public.person_merge_review (guest_player_id, kind, status)
    VALUES ('${G(9)}','auto_merged_email_pair','applied');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id)
    VALUES ('${M(9)}','${A1}','${G(9)}','${PE(9)}');

  -- 10 both-owner guest: academy AND trainer set
  INSERT INTO public.guest_players (id, academy_profile_id, trainer_id)
    VALUES ('${G(10)}','${A1}','${T1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(10)}','${G(10)}');

  -- 11 trainer-only: trainer-owned guest, no academy owner and no direct academy evidence
  INSERT INTO public.guest_players (id, trainer_id) VALUES ('${G(11)}','${T1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(11)}','${G(11)}');

  -- 12 visibility-only: reachable ONLY through the unguarded visibility arm (E9)
  --    pending booking, trainer T2 is active for A1 but owns no DIRECT academy slot
  INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PE(12)}','${P(11)}');
  INSERT INTO public.availability_slots (id, trainer_id) VALUES ('${S(12)}','${T2}');
  INSERT INTO public.bookings (id, slot_id, player_id, status)
    VALUES ('${B(12)}','${S(12)}','${P(11)}','pending');

  -- 13 field conflict: ONE person, two metadata rows at one academy (the soft-removal split),
  --    disagreeing on notes. Also produces a canonical-pair collision (2 candidates → 1 person).
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(13)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(13)}','${G(13)}');
  INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PE(13)}','${P(12)}');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id, notes)
    VALUES ('${M(13)}','${A1}','${G(13)}','${PE(13)}','left wing');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, profile_id, person_id, notes)
    VALUES ('${M(14)}','${A1}','${P(12)}','${PE(13)}','right wing');

  -- 14 academy-owned cyclus cycle (E4 any status / E5 status <> cancelled) and intake (E8).
  --    The CANCELLED booking separates E4 from E5: E4 counts it, E5 must not.
  INSERT INTO public.cycles (id, owner_type, owner_id, type) VALUES ('${S(90)}','academy','${A1}','cyclus');
  INSERT INTO public.availability_slots (id, trainer_id, cyclus_id) VALUES ('${S(14)}','${T1}','${S(90)}');
  INSERT INTO public.guest_players (id) VALUES ('${G(14)}'), ('${G(15)}'), ('${G(16)}');
  INSERT INTO public.person_links (person_id, guest_player_id)
    VALUES ('${PE(14)}','${G(14)}'), ('${PE(15)}','${G(15)}'), ('${PE(16)}','${G(16)}');
  INSERT INTO public.bookings (id, slot_id, guest_player_id, status)
    VALUES ('${B(14)}','${S(14)}','${G(14)}','cancelled'),
           ('${B(15)}','${S(14)}','${G(15)}','confirmed');
  INSERT INTO public.intake_requests (id, cycle_id, guest_player_id, status)
    VALUES ('${B(16)}','${S(90)}','${G(16)}','confirmed');

  -- 15 dismissed-only locations: its OWN disposition (a location the academy dismissed)
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(17)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(17)}','${G(17)}');
  INSERT INTO public.academy_player_locations (id, academy_profile_id, guest_player_id, person_id, dismissed)
    VALUES ('${L(17)}','${A1}','${G(17)}','${PE(17)}', true);

  -- 16 SCOPE BOUNDARY: T1 has a direct A1 slot, but this slot is personal (no academy, no cycle).
  --    The academy scope is by CYCLE, so G30 must NOT be attributed to A1 through it.
  INSERT INTO public.guest_players (id) VALUES ('${G(30)}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(30)}','${G(30)}');
  INSERT INTO public.availability_slots (id, trainer_id) VALUES ('${S(30)}','${T1}');
  INSERT INTO public.bookings (id, slot_id, guest_player_id, status)
    VALUES ('${B(30)}','${S(30)}','${G(30)}','confirmed');

  -- 17 E6/E7 need a DIRECTLY academy-stamped slot that is also in a cycle
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(40)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(40)}','${G(40)}');
  INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id, cyclus_id)
    VALUES ('${S(40)}','${T1}','${A1}','${S(90)}');
  INSERT INTO public.bookings (id, slot_id, guest_player_id, status)
    VALUES ('${B(40)}','${S(40)}','${G(40)}','confirmed');

  -- 18 divergent dual-key reachable ONLY through the cycle scope: this slot shares the academy's
  --    cycle but is NOT academy-stamped and its trainer is NOT an academy trainer, so E1/E2/E6/E7/E9
  --    all miss it and only E4/E5 (cycle) see it.
  INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PE(31)}','${P(31)}');
  INSERT INTO public.guest_players (id) VALUES ('${G(31)}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(32)}','${G(31)}');
  INSERT INTO public.availability_slots (id, trainer_id, cyclus_id)
    VALUES ('${S(41)}','${T3}','${S(90)}');
  INSERT INTO public.bookings (id, slot_id, player_id, guest_player_id, status)
    VALUES ('${B(31)}','${S(41)}','${P(31)}','${G(31)}','confirmed');

  -- 19 two bookings with the SAME key pair → the divergent report is PER ROW, not per pair
  INSERT INTO public.bookings (id, slot_id, player_id, guest_player_id, status)
    VALUES ('${B(32)}','${S(41)}','${P(31)}','${G(31)}','pending');

  -- 19 cross-source overlap: ONE person evidenced by BOTH a metadata row and a location row
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(33)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(33)}','${G(33)}');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id, notes)
    VALUES ('${M(33)}','${A1}','${G(33)}','${PE(33)}','both sources');
  INSERT INTO public.academy_player_locations (id, academy_profile_id, guest_player_id, person_id)
    VALUES ('${L(33)}','${A1}','${G(33)}','${PE(33)}');

  -- 20 E9 guest BRIDGE: a profile made visible at A1 through a shared person with an academy guest
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(34)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(34)}','${G(34)}');
  INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PE(34)}','${P(34)}');

  -- 20b FAM-02 fallback: a dual-key booking whose GUEST is unlinked but whose PROFILE is linked.
  --     The shipped stamp COALESCEs guest→profile, so both resolutions agree and this must NOT be
  --     reported divergent (guest-only resolution would have called it divergent).
  INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PE(60)}','${P(60)}');
  INSERT INTO public.guest_players (id) VALUES ('${G(60)}');   -- deliberately NOT in person_links
  INSERT INTO public.bookings (id, slot_id, player_id, guest_player_id, status)
    VALUES ('${B(60)}','${S(6)}','${P(60)}','${G(60)}','confirmed');

  -- 20c E10 suppression: a guest soft-removed AT THIS ACADEMY drops out of the overview scope,
  --     though its metadata row still makes it a candidate (via S1/E3).
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(61)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(61)}','${G(61)}');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id, removed_at)
    VALUES ('${M(61)}','${A1}','${G(61)}','${PE(61)}', timestamptz '2026-01-01');

  -- 20d E8-only trainer-owned guest: owned by trainer T1 (no academy owner), but with a CONFIRMED
  --     intake on the academy's cycle. E8 is direct academy evidence, so it must NOT be trainer-only.
  INSERT INTO public.guest_players (id, trainer_id) VALUES ('${G(62)}','${T1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(62)}','${G(62)}');
  INSERT INTO public.intake_requests (id, cycle_id, guest_player_id, status)
    VALUES ('${B(62)}','${S(90)}','${G(62)}','confirmed');

  -- 21 raw multiplicity: two location rows for ONE (academy, subject) — expected, not a conflict
  INSERT INTO public.academy_player_locations (id, academy_profile_id, guest_player_id, person_id, location_id)
    VALUES ('${L(34)}','${A1}','${G(33)}','${PE(33)}','${S(80)}');

  -- 22 trainer-owned metadata for a subject that is ALSO an academy candidate (fixture 1's guest).
  --    Owner XOR ⇒ academy_profile_id NULL; it must be reported but must NOT taint A1's candidate.
  INSERT INTO public.academy_player_metadata (id, trainer_profile_id, guest_player_id, person_id, notes)
    VALUES ('${M(50)}','${T1}','${G(1)}','${PE(1)}','trainer-owned note');

  -- second academy relating to the SAME person as fixture 1 → tenant isolation, not a collision
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(20)}','${A2}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(1)}','${G(20)}');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id, notes)
    VALUES ('${M(20)}','${A2}','${G(20)}','${PE(1)}','clean');
`;
