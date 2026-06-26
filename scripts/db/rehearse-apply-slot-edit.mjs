/**
 * Phase 4 F2 rehearsal (PGlite — real Postgres): apply_slot_edit_to_cycle.
 *
 * Proves the set-based "apply to whole cyclus" edit: a RELATIVE time shift applied across slots on
 * DIFFERENT dates (each keeps its own week, time-of-day shifts by the same delta, duration reset),
 * partial patches (only present keys written; present-but-null sets NULL), and the NEW all-or-nothing
 * capacity-shrink guard (refuse the whole edit if any slot's occupancy exceeds the new max).
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();

const CY = '40000000-0000-0000-0000-000000000001';
const S1 = '50000000-0000-0000-0000-000000000001'; // week 1, time-shift test
const S2 = '50000000-0000-0000-0000-000000000002'; // week 2, time-shift test
const S3 = '50000000-0000-0000-0000-000000000003'; // 3 occupying → capacity test
const S4 = '50000000-0000-0000-0000-000000000004'; // 1 occupying → capacity test
const S5 = '50000000-0000-0000-0000-000000000005'; // 2 occupying + 3 cancelled → ignore-non-occupying
const S6 = '50000000-0000-0000-0000-000000000006'; // max 4 but 5 occupying (legacy over-capacity)
const TR_OLD = '10000000-0000-0000-0000-000000000001';
const TR_NEW = '10000000-0000-0000-0000-000000000002';
const LOC_OLD = '30000000-0000-0000-0000-000000000001';

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE public.cycles (id uuid PRIMARY KEY);
  CREATE TABLE public.availability_slots (
    id uuid PRIMARY KEY, cyclus_id uuid,
    start_time timestamptz, end_time timestamptz,
    trainer_id uuid, location_id uuid, max_participants int,
    rating_system text, min_rating numeric, max_rating numeric,
    cyclus_name text, is_public boolean
  );
  CREATE TABLE public.bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slot_id uuid REFERENCES public.availability_slots(id) ON DELETE CASCADE, status text
  );

  INSERT INTO public.cycles VALUES ('${CY}');

  -- S1/S2: same Monday 18:00-19:00, one week apart.
  INSERT INTO public.availability_slots (id, cyclus_id, start_time, end_time, trainer_id, location_id, max_participants, rating_system, is_public) VALUES
    ('${S1}','${CY}','2026-07-06 18:00:00+00','2026-07-06 19:00:00+00','${TR_OLD}','${LOC_OLD}',4,'knltb',true),
    ('${S2}','${CY}','2026-07-13 18:00:00+00','2026-07-13 19:00:00+00','${TR_OLD}','${LOC_OLD}',4,'knltb',true),
    ('${S3}','${CY}','2026-07-06 20:00:00+00','2026-07-06 21:00:00+00','${TR_OLD}',NULL,4,'knltb',true),
    ('${S4}','${CY}','2026-07-13 20:00:00+00','2026-07-13 21:00:00+00','${TR_OLD}',NULL,4,'knltb',true),
    ('${S5}','${CY}','2026-07-20 20:00:00+00','2026-07-20 21:00:00+00','${TR_OLD}',NULL,4,'knltb',true),
    ('${S6}','${CY}','2026-07-27 20:00:00+00','2026-07-27 21:00:00+00','${TR_OLD}',NULL,4,'knltb',true);

  INSERT INTO public.bookings (slot_id, status) VALUES
    ('${S3}','confirmed'),('${S3}','pending'),('${S3}','pending_approval'),  -- 3 occupying
    ('${S4}','confirmed'),                                                     -- 1 occupying
    ('${S5}','confirmed'),('${S5}','pending'),                                 -- 2 occupying
    ('${S5}','cancelled'),('${S5}','cancelled'),('${S5}','declined'),          -- non-occupying (ignored)
    ('${S6}','confirmed'),('${S6}','confirmed'),('${S6}','confirmed'),         -- 5 occupying on a max-4 slot
    ('${S6}','confirmed'),('${S6}','confirmed');                               -- (legacy over-capacity)
`);

await db.exec(readFileSync('supabase/migrations/20260629140000_phase4_f2_apply_slot_edit.sql', 'utf8'));

let pass = 0,
  fail = 0;
const ok = (c, m, x) => {
  c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, x ?? ''));
};
const rpc = async (cy, ids, patch) =>
  (await db.query(`SELECT * FROM public.apply_slot_edit_to_cycle($1, $2, $3::jsonb)`, [cy, ids, JSON.stringify(patch)])).rows[0];
const slot = async (id) => (await db.query(`SELECT * FROM public.availability_slots WHERE id=$1`, [id])).rows[0];
const iso = (ts) => new Date(ts).toISOString();

// ---- A. relative time shift across two DIFFERENT-date slots + a field change --------------------
const a = await rpc(CY, [S1, S2], { start_shift_minutes: 60, duration_minutes: 60, trainer_id: TR_NEW });
ok(Number(a.updated_count) === 2 && Number(a.blocked_count) === 0, 'A: both slots updated, none blocked', a);
const s1 = await slot(S1), s2 = await slot(S2);
ok(iso(s1.start_time) === '2026-07-06T19:00:00.000Z' && iso(s1.end_time) === '2026-07-06T20:00:00.000Z',
  'A: S1 (week 1) shifted 18:00->19:00, end = newstart + 60m', { s: s1.start_time, e: s1.end_time });
ok(iso(s2.start_time) === '2026-07-13T19:00:00.000Z' && iso(s2.end_time) === '2026-07-13T20:00:00.000Z',
  'A: S2 (week 2) shifted independently, keeps its own date', { s: s2.start_time, e: s2.end_time });
ok(s1.trainer_id === TR_NEW && s2.trainer_id === TR_NEW, 'A: absolute field (trainer_id) applied to both', null);

// ---- B. partial patch: only present keys change; absent keys kept -------------------------------
const b = await rpc(CY, [S1], { cyclus_name: 'Zomer A', is_public: false });
const s1b = await slot(S1);
ok(Number(b.updated_count) === 1 && s1b.cyclus_name === 'Zomer A' && s1b.is_public === false,
  'B: cyclus_name + is_public written', b);
ok(s1b.trainer_id === TR_NEW && iso(s1b.start_time) === '2026-07-06T19:00:00.000Z',
  'B: untouched keys (trainer_id, start_time) kept from before', null);

// ---- C. present-but-null sets NULL (location "none") -------------------------------------------
await rpc(CY, [S1], { location_id: null });
ok((await slot(S1)).location_id === null, 'C: present-but-null location_id -> NULL', null);

// ---- D. capacity-shrink guard: ALL-OR-NOTHING -------------------------------------------------
const d = await rpc(CY, [S3, S4], { max_participants: 2 });
ok(Number(d.updated_count) === 0 && Number(d.blocked_count) === 1,
  'D: S3 has 3 occupying > new max 2 -> whole edit blocked', d);
ok((d.blocked_slot_ids ?? [])[0] === S3, 'D: blocked set = {S3}', d.blocked_slot_ids);
ok(Number((await slot(S4)).max_participants) === 4,
  'D: S4 NOT updated either (all-or-nothing, no partial desync)', null);

// ---- E. capacity == occupancy is allowed ------------------------------------------------------
const e = await rpc(CY, [S3, S4], { max_participants: 3 });
ok(Number(e.updated_count) === 2 && Number(e.blocked_count) === 0,
  'E: new max 3 == S3 occupancy 3 -> allowed', e);
ok(Number((await slot(S3)).max_participants) === 3 && Number((await slot(S4)).max_participants) === 3,
  'E: both slots now max 3', null);

// ---- F. guard counts only OCCUPYING bookings (cancelled/declined ignored) ----------------------
const f = await rpc(CY, [S5], { max_participants: 2 });
ok(Number(f.updated_count) === 1 && Number(f.blocked_count) === 0,
  'F: S5 has 2 occupying (+3 cancelled/declined ignored) -> max 2 allowed', f);

// ---- G. empty patch / empty slot ids are clean no-ops -----------------------------------------
const g1 = await rpc(CY, [S1], {});
const g2 = await rpc(CY, [], { is_public: true });
ok(Number(g1.updated_count) === 0 && Number(g2.updated_count) === 0, 'G: empty patch / empty ids -> (0,0,{})', { g1, g2 });

// ---- H. present-but-null max_participants is a NO-OP (does NOT bypass guard + write NULL→cap4) ----
// S6 holds 5 occupying on a max-4 slot. A null max must NOT silently clear capacity (which reads as 4).
const h = await rpc(CY, [S6], { max_participants: null });
ok(Number(h.updated_count) === 1 && Number(h.blocked_count) === 0, 'H: null max -> no-op row update, not blocked', h);
ok(Number((await slot(S6)).max_participants) === 4, 'H: max stays 4 (NOT cleared to NULL/cap-4 bypass)', null);

// ---- I. unchanged max does NOT block a legacy over-occupied slot (guard fires only on real shrink) ----
const i = await rpc(CY, [S6], { max_participants: 4, cyclus_name: 'Touched' });
ok(Number(i.updated_count) === 1 && Number(i.blocked_count) === 0,
  'I: max 4 == current (not a shrink) -> edit applies despite occ 5 > 4', i);
ok((await slot(S6)).cyclus_name === 'Touched', 'I: the non-capacity field was applied', null);

// ---- J. present-but-null trainer_id is a NO-OP (NOT-NULL column never cleared) -----------------
const trBefore = (await slot(S1)).trainer_id;
await rpc(CY, [S1], { trainer_id: null });
ok((await slot(S1)).trainer_id === trBefore, 'J: null trainer_id kept (no-op, no NOT-NULL abort)', null);

// ---- K/L. loud validation: duration must be positive; time keys are both-or-neither --------------
const expectRaise = async (fn, m) => {
  try { await fn(); ok(false, m + ' (expected RAISE)', 'no error'); }
  catch { ok(true, m, null); }
};
await expectRaise(() => rpc(CY, [S1], { start_shift_minutes: 0, duration_minutes: 0 }), 'K: duration 0 raises (no opaque CHECK abort)');
await expectRaise(() => rpc(CY, [S1], { start_shift_minutes: 30 }), 'L: half-specified time edit raises (both-or-neither)');

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
