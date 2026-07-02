// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// P1-3 regression: merge_guest_players must repoint the two ON DELETE CASCADE children
// (session_player_notes.subject_guest_player_id, academy_player_locations.guest_player_id)
// and the two ON DELETE SET NULL captain markers BEFORE deleting the source guest, instead of
// letting the cascade destroy / null them. Runs the REAL function body against real Postgres.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

const SRC = '20000000-0000-0000-0000-0000000000a0'; // source guest (deleted)
const TGT = '20000000-0000-0000-0000-0000000000b0'; // target guest (kept)
const ACAD = '40000000-0000-0000-0000-0000000000c0';
const MGR  = '50000000-0000-0000-0000-0000000000d0'; // manager user id (auth.uid())
const SLOT = '30000000-0000-0000-0000-0000000000e0';
const LOC_SHARED = '60000000-0000-0000-0000-000000000001'; // both guests attached here -> collision
const LOC_SRC_ONLY = '60000000-0000-0000-0000-000000000002'; // only source -> repoint

beforeAll(async () => {
  db = new PGlite();
  // --- minimal schema mirroring prod FK/unique semantics the function touches ---
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    -- auth.uid() returns a GUC we set per-test
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid
    $fn$;

    CREATE TABLE guest_players (
      id uuid PRIMARY KEY,
      full_name text, first_name text, last_name text, email text, phone text,
      skill_rating numeric, rating_system text, birth_date date, notes text,
      billing_business_name text, billing_address text, billing_btw_number text,
      preferred_location_id uuid, source text,
      academy_profile_id uuid, trainer_id uuid,
      has_trained boolean, linked_profile_id uuid
    );
    CREATE TABLE academy_managers (user_id uuid, academy_profile_id uuid);
    CREATE TABLE academy_trainers (academy_profile_id uuid, trainer_profile_id uuid, status text);

    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, guest_player_id uuid REFERENCES guest_players(id) ON DELETE SET NULL,
      player_id uuid, status text, payment_status text, paid_externally boolean,
      paid_by_guest_player_id uuid REFERENCES guest_players(id) ON DELETE SET NULL
    );
    CREATE TABLE invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      guest_player_id uuid REFERENCES guest_players(id)
    );
    CREATE TABLE intake_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      guest_player_id uuid REFERENCES guest_players(id)
    );
    CREATE TABLE slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, guest_player_id uuid REFERENCES guest_players(id) ON DELETE SET NULL,
      booked_by_guest_player_id uuid REFERENCES guest_players(id) ON DELETE SET NULL
    );
    CREATE TABLE academy_player_metadata (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      academy_profile_id uuid, trainer_profile_id uuid,
      guest_player_id uuid REFERENCES guest_players(id) ON DELETE CASCADE,
      tag_ids uuid[] DEFAULT '{}', notes text
    );

    -- the two CASCADE children that were being destroyed
    CREATE TABLE session_player_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid,
      subject_guest_player_id uuid REFERENCES guest_players(id) ON DELETE CASCADE,
      body text
    );
    CREATE TABLE academy_player_locations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      academy_profile_id uuid NOT NULL,
      guest_player_id uuid REFERENCES guest_players(id) ON DELETE CASCADE,
      location_id uuid NOT NULL,
      dismissed boolean NOT NULL DEFAULT false
    );
    CREATE UNIQUE INDEX apl_uniq_guest ON academy_player_locations
      (academy_profile_id, guest_player_id, location_id) WHERE guest_player_id IS NOT NULL;

    -- auth gate stub: real one reads academy_managers
    CREATE OR REPLACE FUNCTION public.is_academy_manager(_user_id uuid, _academy_profile_id uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $fn$
      SELECT EXISTS (SELECT 1 FROM academy_managers
                     WHERE user_id = _user_id AND academy_profile_id = _academy_profile_id)
    $fn$;
  `);

  // --- load the REAL function body (copied verbatim from the P1-3 migration) ---
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.merge_guest_players(
      p_scope text, p_scope_id uuid, p_source_guest_id uuid, p_target_guest_id uuid,
      p_fields jsonb DEFAULT '{}'::jsonb
    ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $body$
    DECLARE
      v_source public.guest_players%ROWTYPE;
      v_target public.guest_players%ROWTYPE;
      v_trainer_ids uuid[];
      v_notes integer := 0;
      v_locations integer := 0;
      v_locations_dropped integer := 0;
      v_captain_claims integer := 0;
      v_captain_bookings integer := 0;
    BEGIN
      IF p_source_guest_id = p_target_guest_id THEN RAISE EXCEPTION 'same'; END IF;
      IF p_scope = 'academy' THEN
        IF NOT public.is_academy_manager(auth.uid(), p_scope_id) THEN
          RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
        END IF;
      END IF;
      SELECT * INTO v_source FROM public.guest_players WHERE id = p_source_guest_id FOR UPDATE;
      SELECT * INTO v_target FROM public.guest_players WHERE id = p_target_guest_id FOR UPDATE;

      UPDATE public.bookings SET guest_player_id = p_target_guest_id WHERE guest_player_id = p_source_guest_id;
      UPDATE public.invoices SET guest_player_id = p_target_guest_id WHERE guest_player_id = p_source_guest_id;
      UPDATE public.intake_requests SET guest_player_id = p_target_guest_id WHERE guest_player_id = p_source_guest_id;
      DELETE FROM public.slot_priority_claims s WHERE s.guest_player_id = p_source_guest_id
        AND EXISTS (SELECT 1 FROM public.slot_priority_claims t WHERE t.slot_id = s.slot_id AND t.guest_player_id = p_target_guest_id);
      UPDATE public.slot_priority_claims SET guest_player_id = p_target_guest_id WHERE guest_player_id = p_source_guest_id;

      -- P1-3 repoints
      UPDATE public.session_player_notes SET subject_guest_player_id = p_target_guest_id
        WHERE subject_guest_player_id = p_source_guest_id;
      GET DIAGNOSTICS v_notes = ROW_COUNT;

      DELETE FROM public.academy_player_locations s WHERE s.guest_player_id = p_source_guest_id
        AND EXISTS (SELECT 1 FROM public.academy_player_locations t
                    WHERE t.guest_player_id = p_target_guest_id
                      AND t.academy_profile_id = s.academy_profile_id
                      AND t.location_id = s.location_id);
      GET DIAGNOSTICS v_locations_dropped = ROW_COUNT;
      UPDATE public.academy_player_locations SET guest_player_id = p_target_guest_id
        WHERE guest_player_id = p_source_guest_id;
      GET DIAGNOSTICS v_locations = ROW_COUNT;

      UPDATE public.slot_priority_claims SET booked_by_guest_player_id = p_target_guest_id
        WHERE booked_by_guest_player_id = p_source_guest_id;
      GET DIAGNOSTICS v_captain_claims = ROW_COUNT;
      UPDATE public.bookings SET paid_by_guest_player_id = p_target_guest_id
        WHERE paid_by_guest_player_id = p_source_guest_id;
      GET DIAGNOSTICS v_captain_bookings = ROW_COUNT;

      UPDATE public.guest_players SET email = NULL WHERE id = p_source_guest_id;
      DELETE FROM public.guest_players WHERE id = p_source_guest_id;

      RETURN jsonb_build_object('notes_moved', v_notes, 'locations_moved', v_locations,
        'locations_deduped', v_locations_dropped, 'captain_claim_markers_moved', v_captain_claims,
        'captain_booking_markers_moved', v_captain_bookings);
    END; $body$;
  `);
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE guest_players, academy_managers, bookings, invoices, intake_requests,
             slot_priority_claims, academy_player_metadata, session_player_notes,
             academy_player_locations CASCADE;
    INSERT INTO guest_players (id, full_name, academy_profile_id) VALUES
      ('${SRC}', 'Source', '${ACAD}'), ('${TGT}', 'Target', '${ACAD}');
    INSERT INTO academy_managers (user_id, academy_profile_id) VALUES ('${MGR}', '${ACAD}');
    -- CASCADE child #1: coaching note about the source
    INSERT INTO session_player_notes (slot_id, subject_guest_player_id, body)
      VALUES ('${SLOT}', '${SRC}', 'great backhand');
    -- CASCADE child #2: locations. shared one collides (both have it), src-only repoints.
    INSERT INTO academy_player_locations (academy_profile_id, guest_player_id, location_id, dismissed) VALUES
      ('${ACAD}', '${SRC}', '${LOC_SHARED}', true),
      ('${ACAD}', '${TGT}', '${LOC_SHARED}', false),
      ('${ACAD}', '${SRC}', '${LOC_SRC_ONLY}', false);
    -- SET NULL captain markers pointing at the source as captain
    INSERT INTO slot_priority_claims (slot_id, guest_player_id, booked_by_guest_player_id)
      VALUES ('${SLOT}', '${TGT}', '${SRC}');
    INSERT INTO bookings (slot_id, guest_player_id, status, paid_by_guest_player_id)
      VALUES ('${SLOT}', '${TGT}', 'confirmed', '${SRC}');
  `);
  await db.exec(`SELECT set_config('test.uid', '${MGR}', false)`);
});

const call = () =>
  db.query(`SELECT public.merge_guest_players('academy','${ACAD}','${SRC}','${TGT}','{}'::jsonb) AS r`);

describe('merge_guest_players P1-3 CASCADE child repoint', () => {
  it('repoints the coaching note instead of cascade-deleting it', async () => {
    await call();
    const notes = (await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM session_player_notes WHERE subject_guest_player_id = '${TGT}'`,
    )).rows[0].n;
    expect(notes).toBe('1');
    const orphaned = (await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM session_player_notes WHERE subject_guest_player_id = '${SRC}'`,
    )).rows[0].n;
    expect(orphaned).toBe('0');
  });

  it('dedups the colliding location and repoints the source-only one', async () => {
    await call();
    // target keeps its own shared-location row (dismissed=false); no duplicate
    const shared = (await db.query<{ n: string; dismissed: boolean }>(
      `SELECT count(*)::text n, bool_and(dismissed) dismissed FROM academy_player_locations
       WHERE guest_player_id = '${TGT}' AND location_id = '${LOC_SHARED}'`,
    )).rows[0];
    expect(shared.n).toBe('1');
    expect(shared.dismissed).toBe(false); // kept the target's flag, dropped source's dismissed=true
    // source-only location repointed onto the target
    const srcOnly = (await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM academy_player_locations
       WHERE guest_player_id = '${TGT}' AND location_id = '${LOC_SRC_ONLY}'`,
    )).rows[0].n;
    expect(srcOnly).toBe('1');
  });

  it('repoints the captain attribution markers instead of nulling them', async () => {
    await call();
    const claim = (await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM slot_priority_claims WHERE booked_by_guest_player_id = '${TGT}'`,
    )).rows[0].n;
    const booking = (await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM bookings WHERE paid_by_guest_player_id = '${TGT}'`,
    )).rows[0].n;
    expect(claim).toBe('1');
    expect(booking).toBe('1');
  });
});
