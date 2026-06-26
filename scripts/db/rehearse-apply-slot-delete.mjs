/**
 * Phase 4 F2 rehearsal (PGlite — real Postgres, no Docker): apply_slot_delete_to_cycle.
 *
 * The whole point of this RPC is the DATA-LOSS GUARD: bookings.slot_id is ON DELETE CASCADE, so the
 * RPC must NEVER delete a slot that still holds a capacity-occupying booking (confirmed / pending /
 * pending_approval), and it must delete the rest atomically. This seeds that exact trap — a real FK
 * cascade on bookings — and proves the protected booked slots (and their bookings) survive while the
 * unbooked / cancelled-booking slots are removed, the split divisor is recomputed for whoever
 * remains, and orphan-cyclus groups (no cycles row) are still deletable.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();

const CY = '40000000-0000-0000-0000-000000000001'; // split cycle, has a cycles row
const CY2 = '40000000-0000-0000-0000-000000000002'; // split cycle (isolates the all-protected test)
const CY_ORPHAN = '40000000-0000-0000-0000-000000000099'; // NO cycles row — orphan cyclus_id group

const S1 = '50000000-0000-0000-0000-000000000001'; // CY, confirmed → protected
const S2 = '50000000-0000-0000-0000-000000000002'; // CY, confirmed → protected
const S3 = '50000000-0000-0000-0000-000000000003'; // CY, no booking → deletable
const S4 = '50000000-0000-0000-0000-000000000004'; // CY, cancelled booking → deletable (booking cascades)
const S5 = '50000000-0000-0000-0000-000000000005'; // CY_ORPHAN, no booking → orphan-group deletable
const S6 = '50000000-0000-0000-0000-000000000006'; // CY2, confirmed → all-protected test
const S7 = '50000000-0000-0000-0000-000000000007'; // no cycle, no booking → null-cycle delete test

const CY3 = '40000000-0000-0000-0000-000000000003'; // split cycle, all-protected reconcile test
const S8 = '50000000-0000-0000-0000-000000000008'; // CY3, confirmed → protected
const S9 = '50000000-0000-0000-0000-000000000009'; // CY3, confirmed → protected
const S10 = '50000000-0000-0000-0000-00000000000a'; // no cycle, cancel-then-delete test

const PA = '20000000-0000-0000-0000-00000000000a';
const PB = '20000000-0000-0000-0000-00000000000b';
const PC = '20000000-0000-0000-0000-00000000000c';
const PD = '20000000-0000-0000-0000-00000000000d';
const PE = '20000000-0000-0000-0000-00000000000e';
const PF = '20000000-0000-0000-0000-00000000000f';

const BK1 = '70000000-0000-0000-0000-000000000001'; // S1, PA, confirmed
const BK2 = '70000000-0000-0000-0000-000000000002'; // S2, PB, confirmed
const BK4 = '70000000-0000-0000-0000-000000000004'; // S4, PC, cancelled
const BK6 = '70000000-0000-0000-0000-000000000006'; // S6, PD, confirmed
const BK8 = '70000000-0000-0000-0000-000000000008'; // S8, PE, confirmed
const BK9 = '70000000-0000-0000-0000-000000000009'; // S9, PF, confirmed
const BK10 = '70000000-0000-0000-0000-00000000000a'; // S10, PA, confirmed → cancelled mid-test
const INV = '60000000-0000-0000-0000-000000000001';
const INV3 = '60000000-0000-0000-0000-000000000003'; // CY3 sibling, stale split_count

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;

  CREATE TABLE public.cycles (id uuid PRIMARY KEY);
  CREATE TABLE public.availability_slots (
    id uuid PRIMARY KEY, cyclus_id uuid, trainer_id uuid, split_payment boolean
  );
  -- The data-loss trap: deleting a slot cascade-deletes its bookings (mirrors prod 20260115210247).
  CREATE TABLE public.bookings (
    id uuid PRIMARY KEY,
    slot_id uuid REFERENCES public.availability_slots(id) ON DELETE CASCADE,
    player_id uuid, guest_player_id uuid, status text
  );
  CREATE TABLE public.invoices (id uuid PRIMARY KEY, status text, split_count int, booking_ids uuid[]);

  INSERT INTO public.cycles VALUES ('${CY}'), ('${CY2}');

  INSERT INTO public.availability_slots (id, cyclus_id, split_payment) VALUES
    ('${S1}','${CY}',true), ('${S2}','${CY}',true), ('${S3}','${CY}',true), ('${S4}','${CY}',true),
    ('${S5}','${CY_ORPHAN}',false), ('${S6}','${CY2}',true), ('${S7}',NULL,false);

  INSERT INTO public.bookings (id, slot_id, player_id, guest_player_id, status) VALUES
    ('${BK1}','${S1}','${PA}',NULL,'confirmed'),
    ('${BK2}','${S2}','${PB}',NULL,'confirmed'),
    ('${BK4}','${S4}','${PC}',NULL,'cancelled'),
    ('${BK6}','${S6}','${PD}',NULL,'confirmed');

  INSERT INTO public.invoices (id, status, split_count, booking_ids) VALUES
    ('${INV}','sent', 1, ARRAY['${BK1}']::uuid[]);
`);

// recalc_cycle_split_count first — the delete RPC composes with it in-transaction.
await db.exec(readFileSync('supabase/migrations/20260614150000_recalc_cycle_split_count.sql', 'utf8'));
await db.exec(readFileSync('supabase/migrations/20260629130000_phase4_f2_apply_slot_delete.sql', 'utf8'));

let pass = 0,
  fail = 0;
const ok = (c, m, x) => {
  c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, x ?? ''));
};
const rpc = async (cy, ids) =>
  (await db.query(`SELECT * FROM public.apply_slot_delete_to_cycle($1, $2)`, [cy, ids])).rows[0];
const exists = async (table, id) =>
  (await db.query(`SELECT 1 FROM public.${table} WHERE id=$1`, [id])).rows.length === 1;
const sorted = (a) => [...(a ?? [])].sort();

// ---- A. the core: protect booked, delete the rest, never cascade an active booking --------------
const a = await rpc(CY, [S1, S2, S3, S4]);
ok(Number(a.deleted_count) === 2, 'A: deleted_count = 2 (S3 unbooked + S4 cancelled-booking)', a);
ok(Number(a.protected_count) === 2, 'A: protected_count = 2 (S1 + S2 confirmed)', a);
ok(JSON.stringify(sorted(a.protected_slot_ids)) === JSON.stringify(sorted([S1, S2])),
  'A: protected_slot_ids = {S1,S2}', a.protected_slot_ids);

ok((await exists('availability_slots', S1)) && (await exists('availability_slots', S2)),
  'A: protected slots S1,S2 SURVIVE', null);
ok(!(await exists('availability_slots', S3)) && !(await exists('availability_slots', S4)),
  'A: deletable slots S3,S4 are gone', null);
// The guard's reason for existing: a protected slot's booking must NOT be cascade-deleted.
ok((await exists('bookings', BK1)) && (await exists('bookings', BK2)),
  'A: DATA-LOSS GUARD — active bookings BK1,BK2 survive (not cascade-deleted)', null);
ok(!(await exists('bookings', BK4)),
  'A: S4 deleted → its cancelled booking BK4 cascade-removed (expected FK behavior)', null);
const inv = (await db.query(`SELECT split_count FROM public.invoices WHERE id='${INV}'`)).rows[0];
ok(Number(inv.split_count) === 2,
  'A: split divisor recomputed in-transaction (PA+PB remain → 2)', inv);

// ---- B. orphan cyclus_id group (no cycles row) is still deletable (DF6) --------------------------
const b = await rpc(CY_ORPHAN, [S5]);
ok(Number(b.deleted_count) === 1 && !(await exists('availability_slots', S5)),
  'B: orphan-cyclus slot deletes (missing cycles row is not an error)', b);

// ---- C. all-protected request deletes nothing, leaves the booking intact ------------------------
const c = await rpc(CY2, [S6]);
ok(Number(c.deleted_count) === 0 && Number(c.protected_count) === 1,
  'C: all-protected → deleted 0, protected 1', c);
ok((await exists('availability_slots', S6)) && (await exists('bookings', BK6)),
  'C: protected slot S6 and its booking BK6 untouched', null);

// ---- D. empty input is a clean no-op ------------------------------------------------------------
const d = await rpc(CY, []);
ok(Number(d.deleted_count) === 0 && Number(d.protected_count) === 0 && (d.protected_slot_ids ?? []).length === 0,
  'D: empty _slot_ids → (0,0,{})', d);

// ---- E. null cycle id → pure delete primitive, no recalc, no error ------------------------------
const e = await rpc(null, [S7]);
ok(Number(e.deleted_count) === 1 && !(await exists('availability_slots', S7)),
  'E: null _cycle_id deletes the unbooked slot (no split-recalc, no lock)', e);

// ---- F. trainer "cancel-then-delete" contract: the RPC is a GUARD, not a canceller ---------------
// While the booking is active the slot is KEPT; after the client cancels it (the trainer flow's step
// that runs BEFORE the RPC), the same call deletes it. Proves protected != deleted, and that the
// cancel-first contract makes a previously-booked slot deletable.
await db.exec(`
  INSERT INTO public.availability_slots (id, cyclus_id, split_payment) VALUES ('${S10}', NULL, false);
  INSERT INTO public.bookings (id, slot_id, player_id, status) VALUES ('${BK10}','${S10}','${PA}','confirmed');
`);
const fBefore = await rpc(null, [S10]);
ok(Number(fBefore.deleted_count) === 0 && Number(fBefore.protected_count) === 1 && (await exists('availability_slots', S10)),
  'F: active booking → slot PROTECTED, not deleted (guard, not canceller)', fBefore);
await db.exec(`UPDATE public.bookings SET status='cancelled' WHERE id='${BK10}'`);
const fAfter = await rpc(null, [S10]);
ok(Number(fAfter.deleted_count) === 1 && !(await exists('availability_slots', S10)),
  'F: after the caller cancels the booking, the slot deletes (cancel-then-delete)', fAfter);

// ---- G. all-protected STILL reconciles the split divisor (parity with academy unconditional recalc) ---
// Dropped the deleted>0 gate: even when nothing is deletable, recalc re-stamps the authoritative 1/N
// onto unpaid siblings — matching the academy delete path, which ran syncSplitCountForCycle regardless.
await db.exec(`
  INSERT INTO public.cycles VALUES ('${CY3}');
  INSERT INTO public.availability_slots (id, cyclus_id, split_payment) VALUES
    ('${S8}','${CY3}',true), ('${S9}','${CY3}',true);
  INSERT INTO public.bookings (id, slot_id, player_id, status) VALUES
    ('${BK8}','${S8}','${PE}','confirmed'), ('${BK9}','${S9}','${PF}','confirmed');
  INSERT INTO public.invoices (id, status, split_count, booking_ids) VALUES
    ('${INV3}','sent', 1, ARRAY['${BK8}']::uuid[]);
`);
const g = await rpc(CY3, [S8, S9]);
ok(Number(g.deleted_count) === 0 && Number(g.protected_count) === 2,
  'G: all slots protected → deleted 0, protected 2', g);
const inv3 = (await db.query(`SELECT split_count FROM public.invoices WHERE id='${INV3}'`)).rows[0];
ok(Number(inv3.split_count) === 2,
  'G: divisor reconciled to 2 even though deleted_count=0 (academy parity, no deleted>0 gate)', inv3);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
