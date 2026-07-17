// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Phase 3.3-attendance: a player seated under their linked GUEST twin can now report attendance.
// Runs the REAL migration with RLS ENABLED on session_reports and drives the player policies under
// SET ROLE authenticated. Proves: a guest-seated (person-merged) player CAN insert + update a
// report and read the trainer summary; the profile-seat case is unchanged; a split-frozen guest is
// refused; the twin/link bridge covers pending-review guests; an unrelated user is refused.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const SLOT = '50000000-0000-0000-0000-000000000001';
const OTHERSLOT = '50000000-0000-0000-0000-000000000002';
const P2SLOT = '50000000-0000-0000-0000-000000000003'; // only seat is a guest stamped to PERSON2
const CANCELSLOT = '50000000-0000-0000-0000-000000000004'; // U's only seat here is CANCELLED
const DUALFROZEN = '50000000-0000-0000-0000-000000000005'; // U's only seat: DUAL-KEYED (player_id=P, guest FROZEN)
const DUALOTHER = '50000000-0000-0000-0000-000000000006'; // U's only seat: DUAL-KEYED (player_id=P, guest of PERSON2)
const GX = '70000000-0000-0000-0000-000000000004'; // guest of PERSON2, seated on P2SLOT
const GXC = '70000000-0000-0000-0000-000000000005'; // U's guest, cancelled seat on CANCELSLOT
const GDF = '70000000-0000-0000-0000-000000000006'; // frozen guest on the DUAL-KEYED DUALFROZEN seat
const GDO = '70000000-0000-0000-0000-000000000007'; // PERSON2's guest on the DUAL-KEYED DUALOTHER seat
// merged person: profile P + guest G (linked via person_links), booking on SLOT is guest-seated
const P = 'a0000000-0000-0000-0000-000000000001';
const U = 'b0000000-0000-0000-0000-000000000001';
const PERSON = 'e0000000-0000-0000-0000-000000000001';
const G = '70000000-0000-0000-0000-000000000001';
// a plain profile-seated player
const P2 = 'a0000000-0000-0000-0000-000000000002';
const U2 = 'b0000000-0000-0000-0000-000000000002';
const PERSON2 = 'e0000000-0000-0000-0000-000000000002';
// twin-bridge guest owner (linked-but-unmerged: twin_of_profile_id set, no person link)
const P3 = 'a0000000-0000-0000-0000-000000000003';
const U3 = 'b0000000-0000-0000-0000-000000000003';
const G3 = '70000000-0000-0000-0000-000000000003';
// unrelated user
const U9 = 'b0000000-0000-0000-0000-000000000009';
const P9 = 'a0000000-0000-0000-0000-000000000009';

async function asUser<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET test.uid = '${uid}'; SET ROLE authenticated;`);
  try { return await fn(); } finally { await db.exec(`RESET ROLE; SET test.uid = '';`); }
}
const failed = async (p: Promise<unknown>): Promise<boolean> => p.then(() => false, () => true);
const insertReport = (slot: string, reporterProfile: string) =>
  db.query(
    `INSERT INTO public.session_reports (slot_id, reporter_id, reporter_role, session_happened)
     VALUES ($1, $2, 'player', true)`, [slot, reporterProfile]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;

    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, twin_of_profile_id uuid, linked_profile_id uuid);
    CREATE TABLE public.persons (id uuid PRIMARY KEY);
    CREATE TABLE public.person_links (person_id uuid, profile_id uuid, guest_player_id uuid);
    CREATE TABLE public.person_merge_review (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text, status text, guest_player_id uuid, person_id uuid);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, trainer_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, player_id uuid, guest_player_id uuid, person_id uuid, status text);
    CREATE TABLE public.session_reports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, reporter_id uuid,
      reporter_role text, session_happened boolean, public_notes text, notes text,
      created_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE public.session_reports ENABLE ROW LEVEL SECURITY;
    GRANT SELECT, INSERT, UPDATE ON public.session_reports TO authenticated;
    GRANT SELECT ON public.availability_slots, public.bookings TO authenticated;

    CREATE OR REPLACE FUNCTION public.get_profile_id_for_user(_u uuid)
      RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT id FROM public.profiles WHERE user_id = _u LIMIT 1 $fn$;
    CREATE OR REPLACE FUNCTION public.get_my_person_id()
      RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT pl.person_id FROM public.person_links pl JOIN public.profiles p ON p.id = pl.profile_id
        WHERE p.user_id = auth.uid() $fn$;
    CREATE OR REPLACE FUNCTION public.is_guest_split_frozen(_guest_player_id uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT _guest_player_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.person_merge_review r
          WHERE r.guest_player_id = _guest_player_id AND r.status = 'pending'
            AND r.kind IN ('twin_detached_needs_split', 'merged_guest_email_moved')) $fn$;

    -- the production SELECT policy (20260713100000, reporter-based, unchanged by this phase);
    -- required so an UPDATE's WHERE can fetch the caller's own row under RLS. Created after
    -- get_profile_id_for_user exists.
    CREATE POLICY "Players can view their own session reports" ON public.session_reports
      FOR SELECT TO authenticated
      USING (session_reports.reporter_id = public.get_profile_id_for_user(auth.uid()));

    INSERT INTO public.availability_slots VALUES
      ('${SLOT}', NULL), ('${OTHERSLOT}', NULL), ('${P2SLOT}', NULL), ('${CANCELSLOT}', NULL),
      ('${DUALFROZEN}', NULL), ('${DUALOTHER}', NULL);
    INSERT INTO public.profiles VALUES ('${P}','${U}'),('${P2}','${U2}'),('${P3}','${U3}'),('${P9}','${U9}');
    INSERT INTO public.persons VALUES ('${PERSON}'),('${PERSON2}');
    INSERT INTO public.guest_players (id) VALUES ('${G}');
    INSERT INTO public.guest_players (id, twin_of_profile_id) VALUES ('${G3}', '${P3}');
    INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PERSON}','${P}'),('${PERSON2}','${P2}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PERSON}','${G}');

    -- SLOT: P is seated as their GUEST twin G (guest_player_id set, player_id NULL, person-stamped)
    INSERT INTO public.bookings (slot_id, guest_player_id, person_id, status)
      VALUES ('${SLOT}', '${G}', '${PERSON}', 'confirmed');
    -- SLOT: P2 is seated under their PROFILE (pure-profile)
    INSERT INTO public.bookings (slot_id, player_id, person_id, status)
      VALUES ('${SLOT}', '${P2}', '${PERSON2}', 'confirmed');
    -- SLOT: P3 is seated as their twin-bridge guest G3
    INSERT INTO public.bookings (slot_id, guest_player_id, status)
      VALUES ('${SLOT}', '${G3}', 'confirmed');
    -- P2SLOT: the ONLY seat is GX, a guest stamped to PERSON2 (a DIFFERENT person than U's PERSON)
    INSERT INTO public.guest_players (id) VALUES ('${GX}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PERSON2}', '${GX}');
    INSERT INTO public.bookings (slot_id, guest_player_id, person_id, status)
      VALUES ('${P2SLOT}', '${GX}', '${PERSON2}', 'confirmed');
    -- CANCELSLOT: U's only seat is a CANCELLED guest booking (their own person, GXC)
    INSERT INTO public.guest_players (id) VALUES ('${GXC}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PERSON}', '${GXC}');
    INSERT INTO public.bookings (slot_id, guest_player_id, person_id, status)
      VALUES ('${CANCELSLOT}', '${GXC}', '${PERSON}', 'cancelled');
    -- DUALFROZEN: U's only seat is DUAL-KEYED (player_id=P AND guest_player_id=GDF, a FROZEN guest).
    -- FAM-02: this row is the guest's — the pure-profile guard must stop the profile arm granting it.
    INSERT INTO public.guest_players (id) VALUES ('${GDF}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PERSON}', '${GDF}');
    INSERT INTO public.bookings (slot_id, player_id, guest_player_id, person_id, status)
      VALUES ('${DUALFROZEN}', '${P}', '${GDF}', '${PERSON}', 'confirmed');
    -- DUALOTHER: U's only seat is DUAL-KEYED (player_id=P AND guest_player_id=GDO, PERSON2's guest).
    INSERT INTO public.guest_players (id) VALUES ('${GDO}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PERSON2}', '${GDO}');
    INSERT INTO public.bookings (slot_id, player_id, guest_player_id, person_id, status)
      VALUES ('${DUALOTHER}', '${P}', '${GDO}', '${PERSON2}', 'confirmed');
    -- a pre-existing TRAINER report on SLOT (for the summaries-view test)
    INSERT INTO public.session_reports (slot_id, reporter_id, reporter_role, session_happened, public_notes, notes)
      VALUES ('${SLOT}', '${P9}', 'trainer', true, 'good session', 'private trainer note');
  `);
  await db.exec(
    readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260831100000_phase33_attendance_person_rls.sql'), 'utf8')
      .split('\n').filter((l) => !/^(REVOKE|GRANT)\b/.test(l)).join('\n'),
  );
  // the harness needs the summaries view + policies granted to authenticated (GRANT lines stripped)
  await db.exec(`
    GRANT EXECUTE ON FUNCTION public.can_report_attendance_on_slot(uuid, boolean) TO authenticated;
    GRANT SELECT ON public.session_reports_player_summaries TO authenticated;
  `);
});

afterEach(async () => {
  await db.exec(`DELETE FROM public.session_reports WHERE reporter_role = 'player';
                 DELETE FROM public.person_merge_review;`);
});

describe('session_reports player RLS — Phase 3.3-attendance', () => {
  it('a GUEST-seated (person-merged) player CAN insert an attendance report', async () => {
    await asUser(U, () => insertReport(SLOT, P));
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM session_reports WHERE slot_id='${SLOT}' AND reporter_id='${P}'`);
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('a PROFILE-seated player can still insert (account holders unchanged)', async () => {
    await asUser(U2, () => insertReport(SLOT, P2));
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM session_reports WHERE reporter_id='${P2}'`);
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('a guest-seated player can UPDATE their own report', async () => {
    await asUser(U, async () => {
      await insertReport(SLOT, P);
      await db.query(`UPDATE public.session_reports SET public_notes='edited' WHERE slot_id='${SLOT}' AND reporter_id='${P}'`);
    });
    const { rows } = await db.query(`SELECT public_notes FROM session_reports WHERE slot_id='${SLOT}' AND reporter_id='${P}'`);
    expect((rows[0] as { public_notes: string }).public_notes).toBe('edited');
  });

  it('the twin-BRIDGE guest owner (pending-review, no person link) CAN insert', async () => {
    await asUser(U3, () => insertReport(SLOT, P3));
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM session_reports WHERE reporter_id='${P3}'`);
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('a SPLIT-FROZEN guest seat does NOT grant reporting (uncertain identity)', async () => {
    await db.exec(`INSERT INTO public.person_merge_review (kind, status, guest_player_id, person_id)
      VALUES ('merged_guest_email_moved', 'pending', '${G}', '${PERSON}');`);
    expect(await failed(asUser(U, () => insertReport(SLOT, P)))).toBe(true);
  });

  it('a user NOT seated on the slot is refused (no dead-grant)', async () => {
    expect(await failed(asUser(U9, () => insertReport(SLOT, P9)))).toBe(true);
  });

  it('FAM-02 dual-keyed bypass (FROZEN guest): the profile arm must NOT grant on a both-keyed frozen-guest seat', async () => {
    // DUALFROZEN's only seat is player_id=P AND guest_player_id=GDF (frozen). Pre-fix the bare
    // b.player_id=me profile arm granted, bypassing the freeze. Pure-profile guard → refused.
    await db.exec(`INSERT INTO public.person_merge_review (kind, status, guest_player_id, person_id)
      VALUES ('merged_guest_email_moved', 'pending', '${GDF}', '${PERSON}');`);
    expect(await failed(asUser(U, () => insertReport(DUALFROZEN, P)))).toBe(true);
    // and the summaries view must not surface a trainer note for it either
    await db.exec(`INSERT INTO public.session_reports (slot_id, reporter_id, reporter_role, session_happened, public_notes)
      VALUES ('${DUALFROZEN}', '${P9}', 'trainer', true, 'frozen dual summary');`);
    const view = await asUser(U, async () =>
      (await db.query(`SELECT id FROM public.session_reports_player_summaries WHERE slot_id='${DUALFROZEN}'`)).rows);
    expect(view).toHaveLength(0);
    await db.exec(`DELETE FROM public.session_reports WHERE slot_id='${DUALFROZEN}';`);
  });

  it('FAM-02 dual-keyed bypass (DIFFERENT person): the profile arm must NOT grant on a both-keyed other-person seat', async () => {
    // DUALOTHER's only seat is player_id=P AND guest_player_id=GDO (PERSON2's guest). FAM-02: the
    // row is PERSON2's; U must be refused even though player_id = their profile.
    expect(await failed(asUser(U, () => insertReport(DUALOTHER, P)))).toBe(true);
    await db.exec(`INSERT INTO public.session_reports (slot_id, reporter_id, reporter_role, session_happened, public_notes)
      VALUES ('${DUALOTHER}', '${P9}', 'trainer', true, 'other dual summary');`);
    const view = await asUser(U, async () =>
      (await db.query(`SELECT id FROM public.session_reports_player_summaries WHERE slot_id='${DUALOTHER}'`)).rows);
    expect(view).toHaveLength(0);
    await db.exec(`DELETE FROM public.session_reports WHERE slot_id='${DUALOTHER}';`);
  });

  it('PERSON-ARM EQUALITY: a person-holding player is refused on a seat stamped to a DIFFERENT person', async () => {
    // P2SLOT's only seat is GX, stamped person_id=PERSON2. U has a person (PERSON) but no seat here.
    // Pins  b.person_id = ctx.person  — a mutation to  b.person_id IS NOT NULL  would wrongly grant.
    expect(await failed(asUser(U, () => insertReport(P2SLOT, P)))).toBe(true);
  });

  it('_require_active: a CANCELLED-only seat still allows INSERT (require_active=false) but the view denies it', async () => {
    // U's only CANCELSLOT seat is cancelled. INSERT (require_active default false) is allowed…
    await asUser(U, () => insertReport(CANCELSLOT, P));
    const { rows: n } = await db.query(`SELECT count(*)::int AS n FROM session_reports WHERE slot_id='${CANCELSLOT}' AND reporter_id='${P}'`);
    expect((n[0] as { n: number }).n).toBe(1);
    // …but the summaries view (require_active=true) shows nothing for a cancelled-only seat.
    await db.exec(`INSERT INTO public.session_reports (slot_id, reporter_id, reporter_role, session_happened, public_notes)
      VALUES ('${CANCELSLOT}', '${P9}', 'trainer', true, 'cancel-slot summary');`);
    const view = await asUser(U, async () =>
      (await db.query(`SELECT id FROM public.session_reports_player_summaries WHERE slot_id='${CANCELSLOT}'`)).rows);
    expect(view).toHaveLength(0);
    await db.exec(`DELETE FROM public.session_reports WHERE slot_id='${CANCELSLOT}';`);
  });

  it('a guest-seated player cannot report on a slot they are NOT on', async () => {
    expect(await failed(asUser(U, () => insertReport(OTHERSLOT, P)))).toBe(true);
  });

  it('reporter_id spoofing is refused (must equal the own profile of the caller)', async () => {
    // U (seated) tries to write a report attributed to P2 — reporter_id clause blocks it
    expect(await failed(asUser(U, () => insertReport(SLOT, P2)))).toBe(true);
  });

  it('the summaries view lets a guest-seated player read the trainer summary (public cols only)', async () => {
    const rows = await asUser(U, async () =>
      (await db.query(`SELECT id, public_notes FROM public.session_reports_player_summaries WHERE slot_id='${SLOT}'`)).rows);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { public_notes: string }).public_notes).toBe('good session');
  });

  it('PRIVACY: the summaries view does NOT expose the private notes / attendees columns', async () => {
    // the trainer report has notes='private trainer note' — the view must never surface it.
    expect(await failed(db.query(`SELECT notes FROM public.session_reports_player_summaries LIMIT 1`))).toBe(true);
    expect(await failed(db.query(`SELECT attendees FROM public.session_reports_player_summaries LIMIT 1`))).toBe(true);
    // and the view's exact column set is the 6 public ones (mirrors the migration's install guard)
    const { rows } = await db.query<{ c: string }>(
      `SELECT attname AS c FROM pg_attribute WHERE attrelid='public.session_reports_player_summaries'::regclass
       AND attnum > 0 AND NOT attisdropped ORDER BY attname`);
    expect(rows.map((r) => r.c)).toEqual(['created_at', 'id', 'public_notes', 'reporter_role', 'session_happened', 'slot_id']);
  });
});
