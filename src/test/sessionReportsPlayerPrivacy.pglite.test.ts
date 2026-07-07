// @vitest-environment node
// Trainer-audit P1 privacy regression: the player SELECT policy from
// 20260531100000 granted the WHOLE trainer session_reports row to any booked
// player — including `notes` (labelled "Private notes (not visible to players)"
// in the attendance form) and the attendees array, readable via PostgREST.
//
// Runs the REAL original policy migration to reproduce the leak, then the REAL
// fix migration (20260713100000: player-safe view + narrowed base policy) and
// proves: base table hides trainer rows from players, the view exposes ONLY the
// public summary, cancelled/unrelated players get nothing, and trainer / player
// own-row access still works.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const TRAINER_USER = '10000000-0000-0000-0000-0000000000a1';
const TRAINER_PROFILE = '10000000-0000-0000-0000-0000000000a2';
const TRAINER_TP = '10000000-0000-0000-0000-0000000000a3';
const PLAYER_USER = '20000000-0000-0000-0000-0000000000b1';
const PLAYER_PROFILE = '20000000-0000-0000-0000-0000000000b2';
const CANCELLED_USER = '30000000-0000-0000-0000-0000000000c1';
const CANCELLED_PROFILE = '30000000-0000-0000-0000-0000000000c2';
const SWAPPED_USER = '60000000-0000-0000-0000-0000000000f1';
const SWAPPED_PROFILE = '60000000-0000-0000-0000-0000000000f2';
const STRANGER_USER = '40000000-0000-0000-0000-0000000000d1';
const STRANGER_PROFILE = '40000000-0000-0000-0000-0000000000d2';
const SLOT = '50000000-0000-0000-0000-0000000000e1';

// Real migration SQL, verbatim — GRANT/REVOKE lines are KEPT (this suite creates
// the anon/authenticated roles so the view grants are part of what's under test).
const readMigration = (name: string) =>
  readFileSync(join(process.cwd(), 'supabase', 'migrations', name), 'utf8');

/** Run fn while impersonating an authenticated user (RLS applies: not the table owner). */
async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SELECT set_config('test.uid', '${userId}', false); SET ROLE authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec(`RESET ROLE; SELECT set_config('test.uid', '', false);`);
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA auth;
    -- auth.uid() stub: reads a settable GUC so tests can impersonate callers.
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid
    $fn$;

    CREATE TABLE profiles (
      id uuid PRIMARY KEY,
      user_id uuid,
      full_name text
    );
    CREATE TABLE trainer_profiles (
      id uuid PRIMARY KEY,
      user_id uuid
    );
    CREATE TABLE availability_slots (
      id uuid PRIMARY KEY,
      trainer_id uuid,
      academy_profile_id uuid,
      start_time timestamptz,
      end_time timestamptz
    );
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid,
      player_id uuid,
      status text
    );
    -- session_reports: the real shape (20260406093000 + public_notes from 20260406093735).
    CREATE TABLE session_reports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid NOT NULL,
      reporter_id uuid NOT NULL,
      reporter_role text NOT NULL,
      session_happened boolean NOT NULL DEFAULT true,
      attendees text[],
      notes text,
      public_notes text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE (slot_id, reporter_id)
    );
    -- Referenced by the 20260531100000 policy set; minimal shapes.
    CREATE TABLE trainer_followers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      player_id uuid,
      trainer_id uuid
    );
    CREATE TABLE notification_preferences (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid
    );

    CREATE FUNCTION public.get_profile_id_for_user(p_user_id uuid) RETURNS uuid
    LANGUAGE sql STABLE AS $fn$
      SELECT id FROM public.profiles WHERE user_id = p_user_id LIMIT 1
    $fn$;
    CREATE FUNCTION public.get_user_academy_ids(p_user_id uuid) RETURNS SETOF uuid
    LANGUAGE sql STABLE AS $fn$
      SELECT NULL::uuid WHERE false
    $fn$;
    CREATE FUNCTION public.is_admin(p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;

    CREATE ROLE anon;
    CREATE ROLE authenticated;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

    -- The pre-existing UPDATE policies the original migration replaces reference
    -- these two policies only via DROP IF EXISTS — nothing else to stub.
  `);

  // The REAL original policy set (row-wide player SELECT — the leak under test).
  await db.exec(readMigration('20260531100000_player_app_security_hardening.sql'));

  await db.exec(`
    INSERT INTO profiles (id, user_id, full_name) VALUES
      ('${TRAINER_PROFILE}', '${TRAINER_USER}', 'Trainer'),
      ('${PLAYER_PROFILE}', '${PLAYER_USER}', 'Booked Player'),
      ('${CANCELLED_PROFILE}', '${CANCELLED_USER}', 'Cancelled Player'),
      ('${SWAPPED_PROFILE}', '${SWAPPED_USER}', 'Swapped-away Player'),
      ('${STRANGER_PROFILE}', '${STRANGER_USER}', 'Stranger');
    INSERT INTO trainer_profiles (id, user_id) VALUES ('${TRAINER_TP}', '${TRAINER_USER}');
    INSERT INTO availability_slots (id, trainer_id, start_time, end_time)
      VALUES ('${SLOT}', '${TRAINER_TP}', now() - interval '2 days', now() - interval '2 days' + interval '1 hour');
    INSERT INTO bookings (slot_id, player_id, status) VALUES
      ('${SLOT}', '${PLAYER_PROFILE}', 'confirmed'),
      ('${SLOT}', '${CANCELLED_PROFILE}', 'cancelled'),
      ('${SLOT}', '${SWAPPED_PROFILE}', 'cancelled_swap');
    INSERT INTO session_reports (slot_id, reporter_id, reporter_role, session_happened, attendees, notes, public_notes)
      VALUES ('${SLOT}', '${TRAINER_PROFILE}', 'trainer', true,
              ARRAY['${PLAYER_PROFILE}'], 'PRIVATE: struggles with backhand', 'Great session, practiced volleys');
  `);
});

describe('session_reports player privacy (real migration SQL)', () => {
  it('reproduces the leak: under the original policy a booked player reads the private notes', async () => {
    const rows = await asUser(PLAYER_USER, () =>
      db.query<{ notes: string | null; attendees: string[] }>(
        `SELECT notes, attendees FROM session_reports WHERE slot_id = $1 AND reporter_role = 'trainer'`,
        [SLOT],
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].notes).toContain('PRIVATE');
    expect(rows.rows[0].attendees).toContain(PLAYER_PROFILE);
  });

  it('fix migration applies cleanly (incl. its install assertions)', async () => {
    await db.exec(readMigration('20260713100000_session_reports_player_privacy.sql'));
  });

  it('after fix: the base table no longer exposes trainer rows to booked players', async () => {
    const rows = await asUser(PLAYER_USER, () =>
      db.query(`SELECT id FROM session_reports WHERE slot_id = $1 AND reporter_role = 'trainer'`, [SLOT]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('after fix: the view gives the booked player the summary — and has NO notes/attendees columns', async () => {
    const rows = await asUser(PLAYER_USER, () =>
      db.query<{ public_notes: string | null; session_happened: boolean }>(
        `SELECT public_notes, session_happened FROM session_reports_player_summaries WHERE slot_id = $1`,
        [SLOT],
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].public_notes).toBe('Great session, practiced volleys');

    let msg = '';
    await asUser(PLAYER_USER, () =>
      db
        .query(`SELECT notes FROM session_reports_player_summaries WHERE slot_id = $1`, [SLOT])
        .catch((e: { message?: string }) => {
          msg = String(e.message ?? e);
          return { rows: [] };
        }),
    );
    expect(msg).toMatch(/notes.*does not exist|column "notes"/i);
  });

  it('a cancelled-booking player gets nothing from the view (old policy let them read)', async () => {
    const rows = await asUser(CANCELLED_USER, () =>
      db.query(`SELECT id FROM session_reports_player_summaries WHERE slot_id = $1`, [SLOT]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('a swapped-away player (cancelled_swap) gets nothing from the view either', async () => {
    const rows = await asUser(SWAPPED_USER, () =>
      db.query(`SELECT id FROM session_reports_player_summaries WHERE slot_id = $1`, [SLOT]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('an unrelated player gets nothing from view or base table', async () => {
    const viaView = await asUser(STRANGER_USER, () =>
      db.query(`SELECT id FROM session_reports_player_summaries WHERE slot_id = $1`, [SLOT]),
    );
    const viaTable = await asUser(STRANGER_USER, () =>
      db.query(`SELECT id FROM session_reports WHERE slot_id = $1`, [SLOT]),
    );
    expect(viaView.rows).toHaveLength(0);
    expect(viaTable.rows).toHaveLength(0);
  });

  it('the player still writes and reads their OWN report row', async () => {
    await asUser(PLAYER_USER, () =>
      db.query(
        `INSERT INTO session_reports (slot_id, reporter_id, reporter_role, session_happened, attendees, notes)
         VALUES ($1, $2, 'player', true, ARRAY[]::text[], NULL)`,
        [SLOT, PLAYER_PROFILE],
      ),
    );
    const own = await asUser(PLAYER_USER, () =>
      db.query<{ session_happened: boolean }>(
        `SELECT session_happened FROM session_reports WHERE slot_id = $1 AND reporter_id = $2`,
        [SLOT, PLAYER_PROFILE],
      ),
    );
    expect(own.rows).toHaveLength(1);
  });

  it('the trainer still reads the full row, private notes included, on their own slot', async () => {
    const rows = await asUser(TRAINER_USER, () =>
      db.query<{ notes: string | null }>(
        `SELECT notes FROM session_reports WHERE slot_id = $1 AND reporter_role = 'trainer'`,
        [SLOT],
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].notes).toContain('PRIVATE');
  });
});
