// @vitest-environment node
// Phase 3.5c part 2 (migration 20260905110000): person-keyed note READ paths + Journey.
// Pins the verify-r1 P1 fix: a coaching note shared on a GUEST seat is readable by the
// merged login-holder (RLS guest-subject arm via subject_guest_reads_as_me), the Journey
// shows guest-seated sessions + their shared notes, the freeze suspends both, and the
// twin bridge covers linked-but-unmerged guests. Runs the REAL migration under
// SET ROLE authenticated for the RLS half.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const TR = '30000000-0000-0000-0000-000000000001';
const TR_U = 'b0000000-0000-0000-0000-0000000000c1';
const SLOT = '50000000-0000-0000-0000-000000000001';
// merged person: profile P (user U) + guest G; frozen guest GF of same person
const U = 'b0000000-0000-0000-0000-000000000001';
const P = 'a0000000-0000-0000-0000-000000000001';
const G = '70000000-0000-0000-0000-000000000001';
const GF = '70000000-0000-0000-0000-000000000002';
const PERSON = 'e0000000-0000-0000-0000-000000000001';
// twin-bridged guest of P (no person link)
const GT = '70000000-0000-0000-0000-000000000003';
// unrelated user
const U9 = 'b0000000-0000-0000-0000-000000000009';
const P9 = 'a0000000-0000-0000-0000-000000000009';

async function asUser<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET test.uid = '${uid}'; SET ROLE authenticated;`);
  try { return await fn(); } finally { await db.exec(`RESET ROLE; SET test.uid = '';`); }
}

const insertNote = async (opts: { guest?: string | null; profile?: string | null; visibility?: string }): Promise<string> => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.session_player_notes (slot_id, author_id, author_role, visibility, body, subject_profile_id, subject_guest_player_id)
     VALUES ($1, $2, 'trainer', $3, 'note body', $4, $5) RETURNING id`,
    [SLOT, TR_U, opts.visibility ?? 'shared', opts.profile ?? null, opts.guest ?? null]);
  return r.rows[0].id;
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon;

    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid UNIQUE, full_name text);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid, business_name text);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, trainer_id uuid,
      academy_profile_id uuid, location_id uuid, start_time timestamptz, end_time timestamptz, cyclus_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, player_id uuid, guest_player_id uuid, person_id uuid, status text);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, twin_of_profile_id uuid, linked_profile_id uuid);
    CREATE TABLE public.persons (id uuid PRIMARY KEY);
    CREATE TABLE public.person_links (person_id uuid, profile_id uuid UNIQUE, guest_player_id uuid UNIQUE);
    CREATE TABLE public.person_merge_review (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text, status text, guest_player_id uuid);
    CREATE TABLE public.session_player_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, author_id uuid,
      author_role text, visibility text, body text, media jsonb,
      subject_profile_id uuid, subject_guest_player_id uuid,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.session_reports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, reporter_id uuid, reporter_role text, session_happened boolean, public_notes text);
    CREATE TABLE public.locations (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.player_rating_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      profile_id uuid, rating numeric, rating_system text, scraped_at timestamptz);
    CREATE TABLE public.academy_managers (user_id uuid, academy_profile_id uuid);
    CREATE TABLE public.coaching_note_views (note_id uuid, profile_id uuid);
    CREATE TABLE public.user_roles (user_id uuid, role text);

    ALTER TABLE public.session_player_notes ENABLE ROW LEVEL SECURITY;
    GRANT SELECT ON public.session_player_notes TO authenticated;

    CREATE OR REPLACE FUNCTION public.get_profile_id_for_user(_u uuid)
      RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT p.id FROM public.profiles p WHERE p.user_id = _u LIMIT 1 $fn$;
    CREATE OR REPLACE FUNCTION public.is_admin(_u uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _u AND role = 'admin') $fn$;
    CREATE OR REPLACE FUNCTION public.get_user_academy_ids(_u uuid)
      RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT academy_profile_id FROM public.academy_managers WHERE user_id = _u $fn$;
    CREATE OR REPLACE FUNCTION public.is_guest_split_frozen(_g uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT _g IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.person_merge_review r
          WHERE r.guest_player_id = _g AND r.status = 'pending'
            AND r.kind IN ('twin_detached_needs_split', 'merged_guest_email_moved')) $fn$;
  `);
  await db.exec(readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260905110000_phase35c_notes_journey_person.sql'), 'utf8'));
  await db.exec(`
    INSERT INTO public.trainer_profiles (id, user_id, business_name) VALUES ('${TR}', '${TR_U}', 'Coach');
    INSERT INTO public.availability_slots (id, trainer_id, start_time, end_time)
      VALUES ('${SLOT}', '${TR}', now() - interval '2 days', now() - interval '2 days' + interval '1 hour');
    INSERT INTO public.profiles (id, user_id, full_name) VALUES
      ('${P}', '${U}', 'Merged'), ('${P9}', '${U9}', 'Unrelated');
    INSERT INTO public.guest_players (id, twin_of_profile_id, linked_profile_id) VALUES
      ('${G}', NULL, NULL), ('${GF}', NULL, NULL), ('${GT}', '${P}', NULL);
    INSERT INTO public.persons VALUES ('${PERSON}');
    INSERT INTO public.person_links (person_id, profile_id, guest_player_id) VALUES
      ('${PERSON}', '${P}', NULL), ('${PERSON}', NULL, '${G}'), ('${PERSON}', NULL, '${GF}');
    INSERT INTO public.person_merge_review (kind, status, guest_player_id)
      VALUES ('twin_detached_needs_split', 'pending', '${GF}');
  `);
});

describe('spn_select_subject_player guest-subject arm (Phase 3.5c p2)', () => {
  it('THE P1 FIX: a note shared on my GUEST seat is readable by me (person arm)', async () => {
    const id = await insertNote({ guest: G });
    const rows = await asUser(U, async () =>
      (await db.query<{ id: string }>(`SELECT id FROM public.session_player_notes`)).rows);
    expect(rows.some((r) => r.id === id)).toBe(true);
  });

  it('twin-bridge guest note readable; frozen guest note NOT; unrelated user sees nothing', async () => {
    const twin = await insertNote({ guest: GT });
    const frozen = await insertNote({ guest: GF });
    const mine = await asUser(U, async () =>
      (await db.query<{ id: string }>(`SELECT id FROM public.session_player_notes`)).rows.map((r) => r.id));
    expect(mine).toContain(twin);
    expect(mine).not.toContain(frozen);
    const theirs = await asUser(U9, async () =>
      (await db.query<{ id: string }>(`SELECT id FROM public.session_player_notes`)).rows);
    expect(theirs.length).toBe(0);
  });

  it('private notes stay invisible to the subject either way', async () => {
    const priv = await insertNote({ guest: G, visibility: 'private' });
    const mine = await asUser(U, async () =>
      (await db.query<{ id: string }>(`SELECT id FROM public.session_player_notes`)).rows.map((r) => r.id));
    expect(mine).not.toContain(priv);
  });
});

describe('get_player_journey person-keying (Phase 3.5c p2)', () => {
  it('guest-seated sessions appear in the journey with their shared notes', async () => {
    await db.query(`INSERT INTO public.bookings (slot_id, guest_player_id, person_id, status) VALUES ($1, $2, $3, 'confirmed')`, [SLOT, G, PERSON]);
    await db.exec(`SET test.uid = '${U}';`);
    const rows = (await db.query<{ slot_id: string; shared_coaching_notes: unknown[] }>(
      `SELECT slot_id, shared_coaching_notes FROM public.get_player_journey($1)`, [P])).rows;
    await db.exec(`SET test.uid = '';`);
    expect(rows.some((r) => r.slot_id === SLOT)).toBe(true);
    const mine = rows.find((r) => r.slot_id === SLOT)!;
    expect((mine.shared_coaching_notes as unknown[]).length).toBeGreaterThan(0);
    await db.exec(`DELETE FROM public.bookings`);
  });

  it('a FROZEN guest seat does NOT appear (its ref is excluded from the ref-set)', async () => {
    await db.query(`INSERT INTO public.bookings (slot_id, guest_player_id, person_id, status) VALUES ($1, $2, $3, 'confirmed')`, [SLOT, GF, PERSON]);
    await db.exec(`SET test.uid = '${U}';`);
    const rows = (await db.query<{ slot_id: string }>(
      `SELECT slot_id FROM public.get_player_journey($1)`, [P])).rows;
    await db.exec(`SET test.uid = '';`);
    expect(rows.some((r) => r.slot_id === SLOT)).toBe(false);
    await db.exec(`DELETE FROM public.bookings`);
  });

  it('unseen-feedback badge counts guest-keyed shared notes (Codex P2)', async () => {
    await db.exec(`DELETE FROM public.session_player_notes; DELETE FROM public.coaching_note_views;`);
    await insertNote({ guest: G });
    await db.exec(`SET test.uid = '${U}';`);
    const n = (await db.query<{ c: number }>(
      `SELECT public.get_unseen_shared_feedback_count($1) AS c`, [P])).rows[0].c;
    await db.exec(`SET test.uid = '';`);
    expect(n).toBe(1);
  });

  it('another player cannot pull my journey', async () => {
    await db.exec(`SET test.uid = '${U9}';`);
    const denied = await db.query(`SELECT * FROM public.get_player_journey($1)`, [P]).then(() => false, () => true);
    await db.exec(`SET test.uid = '';`);
    expect(denied).toBe(true);
  });
});
