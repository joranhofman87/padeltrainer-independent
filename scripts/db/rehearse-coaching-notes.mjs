// Rehearsal for Coaching & Progress v1 (session_player_notes + RLS + RPCs).
// Proves the RLS VISIBILITY MATRIX (the crux) + get_player_journey auth, via
// SET ROLE authenticated + a settable auth.uid() shim.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, JSON.stringify(x ?? ''))); };
const raises = async (sql) => { try { await db.exec(sql); return false; } catch { return true; } };

// ---- ids ----
const UT = '11000000-0000-0000-0000-0000000000a1';
const UM = '11000000-0000-0000-0000-0000000000b1';
const UP1 = '11000000-0000-0000-0000-0000000000c1';
const UP2 = '11000000-0000-0000-0000-0000000000c2';
const UOTHER = '11000000-0000-0000-0000-0000000000ff';
const T = '12000000-0000-0000-0000-000000000001';
const A = '13000000-0000-0000-0000-000000000001';
const P1 = '14000000-0000-0000-0000-000000000001';
const P2 = '14000000-0000-0000-0000-000000000002';
const G = '15000000-0000-0000-0000-000000000001';
const L1 = '16000000-0000-0000-0000-000000000001';
const S1 = '17000000-0000-0000-0000-000000000001'; // academy slot, past
const S2 = '17000000-0000-0000-0000-000000000002'; // independent (academy NULL), past

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS
    $$ SELECT nullif(current_setting('rehearse.uid', true), '')::uuid $$;

  CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

  -- minimal real tables the policies/RPC reference
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, full_name text);
  CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid, business_name text);
  CREATE TABLE public.academy_managers (user_id uuid, academy_profile_id uuid);
  CREATE TABLE public.locations (id uuid PRIMARY KEY, name text);
  CREATE TABLE public.guest_players (id uuid PRIMARY KEY);
  CREATE TABLE public.availability_slots (
    id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid,
    start_time timestamptz, end_time timestamptz, location_id uuid);
  CREATE TABLE public.bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid,
    player_id uuid, guest_player_id uuid, status text);
  CREATE TABLE public.session_reports (
    slot_id uuid, reporter_id uuid, reporter_role text,
    session_happened boolean, public_notes text);
  CREATE TABLE public.player_rating_history (
    profile_id uuid, rating numeric, rating_system text, scraped_at timestamptz);

  -- SECURITY DEFINER helper stubs (mirror the real signatures)
  CREATE FUNCTION public.get_profile_id_for_user(_user_id uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT id FROM public.profiles WHERE user_id = _user_id LIMIT 1 $$;
  CREATE FUNCTION public.get_user_academy_ids(_user_id uuid) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT academy_profile_id FROM public.academy_managers WHERE user_id = _user_id $$;
  CREATE FUNCTION public.is_admin(_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT false $$;

  -- seed
  INSERT INTO public.profiles VALUES ('${P1}','${UP1}','Player One'), ('${P2}','${UP2}','Player Two');
  INSERT INTO public.trainer_profiles VALUES ('${T}','${UT}','Padel Academy Pro');
  INSERT INTO public.academy_managers VALUES ('${UM}','${A}');
  INSERT INTO public.locations VALUES ('${L1}','Court 1');
  INSERT INTO public.guest_players VALUES ('${G}');
  INSERT INTO public.availability_slots VALUES
    ('${S1}','${T}','${A}','2026-06-01T10:00Z','2026-06-01T11:00Z','${L1}'),
    ('${S2}','${T}',NULL,'2026-06-02T10:00Z','2026-06-02T11:00Z','${L1}');
  INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status) VALUES
    ('${S1}','${P1}',NULL,'confirmed'), ('${S1}','${P2}',NULL,'confirmed'),
    ('${S1}',NULL,'${G}','confirmed'), ('${S2}','${P1}',NULL,'confirmed');
  INSERT INTO public.session_reports VALUES
    ('${S1}','${T}','trainer',true,'Great group energy today'),
    ('${S1}','${P1}','player',true,NULL);
  INSERT INTO public.player_rating_history VALUES ('${P1}',6.0,'knltb','2026-05-01T00:00Z');
`);

await db.exec(readFileSync('supabase/migrations/20260615100000_session_player_notes.sql', 'utf8'));
await db.exec(readFileSync('supabase/migrations/20260615100010_get_player_journey.sql', 'utf8'));
await db.exec(readFileSync('supabase/migrations/20260615100020_coaching_note_views.sql', 'utf8'));
await db.exec(readFileSync('supabase/migrations/20260615100030_coaching_notes_schema_test.sql', 'utf8'));

// Supabase auto-grants table privileges to authenticated on new public tables
// (RLS is the real gate). PGlite has no such default — replicate it so the
// authenticated role can reach the tables the policies reference.
await db.exec(`
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.session_player_notes TO authenticated;
  GRANT SELECT, INSERT ON public.coaching_note_views TO authenticated;
  GRANT SELECT ON public.availability_slots, public.trainer_profiles, public.bookings,
    public.profiles, public.guest_players, public.session_reports, public.locations,
    public.player_rating_history TO authenticated;
`);

// seed notes as superuser (RLS bypassed). label → id
const N = {
  tcPriv:    '18000000-0000-0000-0000-000000000001',
  tcShared:  '18000000-0000-0000-0000-000000000002',
  acPriv:    '18000000-0000-0000-0000-000000000003',
  selfPriv:  '18000000-0000-0000-0000-000000000004',
  selfShared:'18000000-0000-0000-0000-000000000005',
  guest:     '18000000-0000-0000-0000-000000000006',
  s2note:    '18000000-0000-0000-0000-000000000007', // trainer→P1 shared, on the independent slot S2
};
await db.exec(`
  INSERT INTO public.session_player_notes (id, slot_id, author_id, author_role, subject_profile_id, subject_guest_player_id, visibility, body) VALUES
    ('${N.tcPriv}','${S1}','${UT}','trainer','${P1}',NULL,'private','work on backhand'),
    ('${N.tcShared}','${S1}','${UT}','trainer','${P1}',NULL,'shared','great serve today'),
    ('${N.acPriv}','${S1}','${UM}','academy','${P1}',NULL,'private','academy oversight note'),
    ('${N.selfPriv}','${S1}','${UP1}','player','${P1}',NULL,'private','felt tired'),
    ('${N.selfShared}','${S1}','${UP1}','player','${P1}',NULL,'shared','want to focus on volleys'),
    ('${N.guest}','${S1}','${UT}','trainer',NULL,'${G}','private','guest note'),
    ('${N.s2note}','${S2}','${UT}','trainer','${P1}',NULL,'shared','independent slot note');
`);

const asUser = async (uid) => db.exec(`RESET ROLE; SELECT set_config('rehearse.uid','${uid}',false); SET ROLE authenticated;`);
const visibleIds = async (uid) => {
  await asUser(uid);
  const rows = (await db.query(`SELECT id FROM public.session_player_notes`)).rows.map(r => r.id);
  await db.exec(`RESET ROLE`);
  return new Set(rows);
};
const labelsOf = (set) => Object.entries(N).filter(([, id]) => set.has(id)).map(([k]) => k).sort();

// ===== SELECT visibility matrix =====
const p1 = await visibleIds(UP1);
ok(p1.has(N.tcShared) && !p1.has(N.tcPriv), 'P1 sees the SHARED trainer note, not the PRIVATE one', labelsOf(p1));
ok(p1.has(N.s2note), 'P1 sees a shared note on the independent (academy NULL) slot', labelsOf(p1));
ok(!p1.has(N.acPriv), 'P1 does NOT see the academy private note', labelsOf(p1));
// P1 authored their own self-notes → sees both via author policy
ok(p1.has(N.selfPriv) && p1.has(N.selfShared), 'P1 sees own self-notes (author)', labelsOf(p1));

const p2 = await visibleIds(UP2);
ok(![N.tcPriv, N.tcShared, N.acPriv, N.selfPriv, N.selfShared, N.guest].some(id => p2.has(id)),
  'P2 sees NONE of P1/guest notes (cross-player isolation)', labelsOf(p2));

const t = await visibleIds(UT);
ok(t.has(N.tcPriv) && t.has(N.tcShared) && t.has(N.acPriv) && t.has(N.guest),
  'Trainer sees ALL coaching notes on their slot (incl academy + guest)', labelsOf(t));
ok(t.has(N.selfShared) && !t.has(N.selfPriv),
  'Trainer sees a player self-note ONLY when shared', labelsOf(t));

const m = await visibleIds(UM);
ok(m.has(N.tcPriv) && m.has(N.tcShared) && m.has(N.acPriv) && m.has(N.guest),
  'Academy manager sees coaching notes ALWAYS (incl private drafts)', labelsOf(m));
ok(m.has(N.selfShared) && !m.has(N.selfPriv),
  'Academy manager sees a player self-note ONLY when shared', labelsOf(m));
ok(!m.has(N.s2note), 'Academy manager does NOT see notes on the independent (academy NULL) slot', labelsOf(m));

const other = await visibleIds(UOTHER);
ok(other.size === 0, 'Unrelated user sees nothing', labelsOf(other));

// ===== INSERT integrity =====
await asUser(UP1);
ok(await raises(`INSERT INTO public.session_player_notes (slot_id, author_id, author_role, subject_profile_id, visibility, body) VALUES ('${S1}','${UP1}','player','${P2}','private','x')`),
  'P1 CANNOT write a self-note about P2', null);
ok(await raises(`INSERT INTO public.session_player_notes (slot_id, author_id, author_role, subject_guest_player_id, visibility, body) VALUES ('${S1}','${UP1}','player','${G}','private','x')`),
  'player-authored note about a guest is rejected (CHECK)', null);
await db.exec(`RESET ROLE`);
await asUser(UT);
ok(await raises(`INSERT INTO public.session_player_notes (slot_id, author_id, author_role, subject_profile_id, visibility, body) VALUES ('${S2}','${UT}','trainer','${P2}','shared','x')`),
  'trainer CANNOT note a player not booked on the slot', null);
ok(!(await raises(`INSERT INTO public.session_player_notes (slot_id, author_id, author_role, subject_profile_id, visibility, body) VALUES ('${S1}','${UT}','trainer','${P1}','shared','ok')`)),
  'trainer CAN note a booked player on their slot', null);
await db.exec(`RESET ROLE`);

// ===== get_player_journey auth + shape =====
const journey = async (uid, target) => {
  await asUser(uid);
  let out;
  try { out = (await db.query(`SELECT * FROM public.get_player_journey('${target}')`)).rows; }
  catch (e) { out = { error: e.message }; }
  await db.exec(`RESET ROLE`);
  return out;
};
const jP1 = await journey(UP1, P1);
ok(Array.isArray(jP1) && jP1.length === 2, 'journey(P1) by P1 returns 2 past sessions (S1+S2)', Array.isArray(jP1) ? jP1.length : jP1);
const s1row = Array.isArray(jP1) ? jP1.find(r => r.slot_id === S1) : null;
ok(s1row && s1row.group_summary === 'Great group energy today', 'journey row carries the group summary', s1row?.group_summary);
ok(s1row && s1row.session_happened === true && s1row.trainer_confirmed === true && s1row.player_confirmed === true,
  'journey row carries attendance double-control booleans', s1row && { sh: s1row.session_happened, t: s1row.trainer_confirmed, p: s1row.player_confirmed });
ok(s1row && Array.isArray(s1row.shared_coaching_notes) && s1row.shared_coaching_notes.some(n => n.body === 'great serve today')
  && !s1row.shared_coaching_notes.some(n => n.body === 'work on backhand'),
  'journey shared_coaching_notes = only SHARED trainer notes (not private)', s1row?.shared_coaching_notes);
ok(s1row && Array.isArray(s1row.own_notes) && s1row.own_notes.length === 2,
  'journey own_notes = all of P1 self-notes (private + shared)', s1row?.own_notes?.length);
ok(s1row && Number(s1row.rating_at_session) === 6, 'journey carries the per-session rating snapshot', s1row?.rating_at_session);
ok(Number(s1row?.total_count) === 2, 'journey total_count = 2', s1row?.total_count);

ok(Array.isArray(await journey(UT, P1)), 'journey(P1) callable by the trainer', null);
ok(Array.isArray(await journey(UM, P1)), 'journey(P1) callable by the academy manager', null);
const jP2 = await journey(UP2, P1);
ok(!Array.isArray(jP2) && /not authorized/.test(jP2.error || ''), 'journey(P1) by P2 → 42501 not authorized', jP2);

// ===== unseen feedback count =====
await asUser(UP1);
// 3 shared trainer/academy notes about P1 at this point: tcShared + s2note + the
// 'ok' note inserted by the "trainer CAN note a booked player" assertion above.
const unseen0 = (await db.query(`SELECT public.get_unseen_shared_feedback_count('${P1}') AS c`)).rows[0].c;
ok(Number(unseen0) === 3, 'unseen shared feedback = 3 (all shared coaching notes about P1)', unseen0);
await db.query(`INSERT INTO public.coaching_note_views (profile_id, note_id) VALUES ('${P1}','${N.tcShared}')`);
const unseen1 = (await db.query(`SELECT public.get_unseen_shared_feedback_count('${P1}') AS c`)).rows[0].c;
ok(Number(unseen1) === 2, 'after marking one seen, unseen drops by 1', unseen1);
await db.exec(`RESET ROLE`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
