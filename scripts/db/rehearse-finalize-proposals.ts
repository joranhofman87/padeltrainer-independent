/**
 * PGlite rehearsal for the atomic proposal-finalization RPC
 * (20260701120000_finalize_cycle_proposals_rpc.sql). Real Postgres in WASM; runs the ACTUAL
 * migration against a synthetic schema and asserts the all-or-nothing contract:
 *   - happy path: proposed intakes flip to 'booked', one booking per proposed assignment is created,
 *     those assignments flip to 'confirmed'; a 'new' (not-proposed) intake is left alone;
 *   - the booked-vs-bookings split: a claimed intake with no assignment counts toward booked_intakes
 *     but produces no booking;
 *   - re-run idempotency: calling again claims nothing and creates no duplicate bookings;
 *   - empty cycle: booked_intakes=0, no writes;
 *   - ATOMICITY: when one booking INSERT fails (FK violation on a stale slot), the WHOLE call rolls
 *     back — intakes stay 'proposed', assignments stay 'proposed', zero bookings — so the caller can
 *     safely re-run. This is the regression the RPC exists to prevent.
 *
 * Run: npx tsx scripts/db/rehearse-finalize-proposals.ts
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const db = new PGlite();
let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
};

const C = '00000000-0000-0000-0000-0000000000c1'; // happy-path cycle
const EMPTY = '00000000-0000-0000-0000-0000000000c2'; // cycle with no proposed intakes
const R = '00000000-0000-0000-0000-0000000000c3'; // rollback cycle
const S1 = '00000000-0000-0000-0000-0000000000a1';
const S2 = '00000000-0000-0000-0000-0000000000a2';
const SX = '00000000-0000-0000-0000-0000000000af'; // a slot id that is NOT in availability_slots
const P1 = '00000000-0000-0000-0000-0000000000b1';
const P4 = '00000000-0000-0000-0000-0000000000b4';
const G2 = '00000000-0000-0000-0000-0000000000d2';
const G3 = '00000000-0000-0000-0000-0000000000d3';

// ── Synthetic schema. status columns are plain text (no restrictive CHECK) so the RPC's
//    status='booked' write behaves as it does in prod. bookings.slot_id carries the FK that makes a
//    stale-slot INSERT fail — the lever for the atomicity test. ──
await db.exec(`
-- Supabase provides this base role in a real db reset; stub it so the migration's GRANT applies.
CREATE ROLE service_role;

CREATE TABLE public.availability_slots (id uuid PRIMARY KEY);

CREATE TABLE public.intake_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'new',
  player_id uuid,
  guest_player_id uuid,
  invoice_id uuid
);

CREATE TABLE public.proposed_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_request_id uuid NOT NULL REFERENCES public.intake_requests(id) ON DELETE CASCADE,
  slot_id uuid NOT NULL,
  trainer_id uuid,
  status text NOT NULL DEFAULT 'proposed'
);

CREATE TABLE public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id uuid NOT NULL REFERENCES public.availability_slots(id),
  player_id uuid,
  guest_player_id uuid,
  status text NOT NULL DEFAULT 'pending',
  payment_status text NOT NULL DEFAULT 'pending',
  payment_amount numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.availability_slots (id) VALUES ('${S1}'), ('${S2}');

-- Happy-path cycle C: I1(player,S1) I2(guest,S1) I3(guest,S2) all proposed+assigned,
-- I4(player) proposed but NO assignment, I5(player) status 'new' (must NOT be claimed).
INSERT INTO public.intake_requests (id, cycle_id, status, player_id, guest_player_id) VALUES
  ('00000000-0000-0000-0000-0000000e0001', '${C}', 'proposed', '${P1}', NULL),
  ('00000000-0000-0000-0000-0000000e0002', '${C}', 'proposed', NULL, '${G2}'),
  ('00000000-0000-0000-0000-0000000e0003', '${C}', 'proposed', NULL, '${G3}'),
  ('00000000-0000-0000-0000-0000000e0004', '${C}', 'proposed', '${P4}', NULL),
  ('00000000-0000-0000-0000-0000000e0005', '${C}', 'new',      '${P1}', NULL);

INSERT INTO public.proposed_assignments (intake_request_id, slot_id, status) VALUES
  ('00000000-0000-0000-0000-0000000e0001', '${S1}', 'proposed'),
  ('00000000-0000-0000-0000-0000000e0002', '${S1}', 'proposed'),
  ('00000000-0000-0000-0000-0000000e0003', '${S2}', 'proposed');

-- Rollback cycle R: R1(assigned to STALE slot SX → its booking INSERT will fail),
-- R2(assigned to valid S1). One bad row must roll the whole call back.
INSERT INTO public.intake_requests (id, cycle_id, status, player_id, guest_player_id) VALUES
  ('00000000-0000-0000-0000-0000000e0011', '${R}', 'proposed', '${P1}', NULL),
  ('00000000-0000-0000-0000-0000000e0012', '${R}', 'proposed', '${P4}', NULL);
INSERT INTO public.proposed_assignments (intake_request_id, slot_id, status) VALUES
  ('00000000-0000-0000-0000-0000000e0011', '${SX}', 'proposed'),
  ('00000000-0000-0000-0000-0000000e0012', '${S1}', 'proposed');
`);

// ── Apply the ACTUAL migration ──
const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260701120000_finalize_cycle_proposals_rpc.sql'),
  'utf8',
);
await db.exec(migration);

type FinalizeResult = {
  booked_intakes: number;
  bookings: { id: string; player_id: string | null; guest_player_id: string | null; slot_id: string }[];
};
const finalize = async (cycle: string): Promise<FinalizeResult> =>
  (await db.query<{ result: FinalizeResult }>(
    `SELECT public.finalize_cycle_proposals($1) AS result`, [cycle])).rows[0].result;
const count = async (sql: string, params: unknown[] = []) =>
  Number((await db.query<{ n: number }>(sql, params)).rows[0].n);

// ── 1. Happy path ──
const res = await finalize(C);
check('happy: booked_intakes counts all 4 proposed intakes (not the new one)', res.booked_intakes === 4, res.booked_intakes);
check('happy: 3 bookings created (one per assignment; the assignment-less intake makes none)', res.bookings.length === 3, res.bookings.length);

const bookedC = await count(`SELECT count(*)::int n FROM public.intake_requests WHERE cycle_id=$1 AND status='booked'`, [C]);
const newC = await count(`SELECT count(*)::int n FROM public.intake_requests WHERE cycle_id=$1 AND status='new'`, [C]);
check('happy: the 4 proposed intakes are now booked', bookedC === 4, bookedC);
check("happy: the 'new' intake was left untouched", newC === 1, newC);

const confirmedA = await count(`SELECT count(*)::int n FROM public.proposed_assignments WHERE status='confirmed'`);
check('happy: all 3 assignments confirmed', confirmedA === 3, confirmedA);

const bookingsTotal = await count(`SELECT count(*)::int n FROM public.bookings`);
check('happy: exactly 3 booking rows exist', bookingsTotal === 3, bookingsTotal);
const s1Bookings = await count(`SELECT count(*)::int n FROM public.bookings WHERE slot_id=$1`, [S1]);
check('happy: 2 bookings on the shared slot S1', s1Bookings === 2, s1Bookings);
const guestBooking = await count(`SELECT count(*)::int n FROM public.bookings WHERE guest_player_id=$1 AND slot_id=$2`, [G2, S1]);
check('happy: guest G2 booked on S1', guestBooking === 1, guestBooking);
const allConfirmedPending = await count(
  `SELECT count(*)::int n FROM public.bookings WHERE status='confirmed' AND payment_status='pending'`);
check('happy: every booking is confirmed + payment pending', allConfirmedPending === 3, allConfirmedPending);

// ── 2. Re-run idempotency (no proposed left → no double-book) ──
const rerun = await finalize(C);
check('re-run: claims zero, creates zero', rerun.booked_intakes === 0 && rerun.bookings.length === 0, rerun);
check('re-run: still exactly 3 bookings (no duplicates)', (await count(`SELECT count(*)::int n FROM public.bookings`)) === 3);

// ── 3. Empty cycle ──
const empty = await finalize(EMPTY);
check('empty: booked_intakes=0, no bookings', empty.booked_intakes === 0 && empty.bookings.length === 0, empty);

// ── 4. ATOMICITY: a failing booking INSERT rolls the WHOLE call back ──
let threw = false;
try {
  await finalize(R);
} catch {
  threw = true;
}
check('atomicity: the call raised on the stale-slot booking', threw);
const proposedR = await count(`SELECT count(*)::int n FROM public.intake_requests WHERE cycle_id=$1 AND status='proposed'`, [R]);
check('atomicity: BOTH R intakes remain proposed (claim rolled back)', proposedR === 2, proposedR);
const bookedR = await count(`SELECT count(*)::int n FROM public.intake_requests WHERE cycle_id=$1 AND status='booked'`, [R]);
check('atomicity: NO R intake was left orphaned as booked', bookedR === 0, bookedR);
const assignR = await count(
  `SELECT count(*)::int n FROM public.proposed_assignments pa
     JOIN public.intake_requests ir ON ir.id = pa.intake_request_id
    WHERE ir.cycle_id=$1 AND pa.status='confirmed'`, [R]);
check("atomicity: no R assignment was confirmed", assignR === 0, assignR);
const bookingsAfterR = await count(`SELECT count(*)::int n FROM public.bookings`);
check('atomicity: no partial booking from R (still 3 total from cycle C)', bookingsAfterR === 3, bookingsAfterR);
check('atomicity: re-running R is still possible (the rows are intact)', proposedR === 2);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
