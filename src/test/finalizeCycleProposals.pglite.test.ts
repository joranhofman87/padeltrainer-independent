// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// CI spec for the atomic proposal-finalization RPC (20260701120000_finalize_cycle_proposals_rpc.sql).
// Runs the ACTUAL migration against real Postgres (PGlite) and pins the all-or-nothing contract so it
// is verified on every CI run (not only by the standalone scripts/db/rehearse-finalize-proposals.ts).
// The scenarios run in order against one DB (mirroring the rehearsal): the re-run/idempotency case
// depends on the happy path having finalized cycle C.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const C = '00000000-0000-0000-0000-0000000000c1'; // happy-path cycle
const EMPTY = '00000000-0000-0000-0000-0000000000c2'; // cycle with no proposed intakes
const R = '00000000-0000-0000-0000-0000000000c3'; // rollback cycle
const S1 = '00000000-0000-0000-0000-0000000000a1';
const S2 = '00000000-0000-0000-0000-0000000000a2';
const SX = '00000000-0000-0000-0000-0000000000af'; // a slot id NOT in availability_slots → its booking INSERT fails
const P1 = '00000000-0000-0000-0000-0000000000b1';
const P4 = '00000000-0000-0000-0000-0000000000b4';
const G2 = '00000000-0000-0000-0000-0000000000d2';
const G3 = '00000000-0000-0000-0000-0000000000d3';

type FinalizeResult = {
  booked_intakes: number;
  bookings: { id: string; player_id: string | null; guest_player_id: string | null; slot_id: string }[];
};
const finalize = async (cycle: string): Promise<FinalizeResult> =>
  (await db.query<{ result: FinalizeResult }>(`SELECT public.finalize_cycle_proposals($1) AS result`, [cycle])).rows[0].result;
const count = async (sql: string, params: unknown[] = []) =>
  Number((await db.query<{ n: number }>(sql, params)).rows[0].n);

beforeAll(async () => {
  db = new PGlite();
  // Synthetic schema. status columns are plain text (no restrictive CHECK) so the RPC's
  // status='booked' write behaves as in prod. bookings.slot_id carries the FK that makes a
  // stale-slot INSERT fail — the lever for the atomicity test.
  await db.exec(`
    CREATE ROLE service_role;
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY);
    CREATE TABLE public.intake_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cycle_id uuid NOT NULL,
      status text NOT NULL DEFAULT 'new', player_id uuid, guest_player_id uuid, invoice_id uuid);
    CREATE TABLE public.proposed_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      intake_request_id uuid NOT NULL REFERENCES public.intake_requests(id) ON DELETE CASCADE,
      slot_id uuid NOT NULL, trainer_id uuid, status text NOT NULL DEFAULT 'proposed');
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid NOT NULL REFERENCES public.availability_slots(id),
      player_id uuid, guest_player_id uuid, status text NOT NULL DEFAULT 'pending',
      payment_status text NOT NULL DEFAULT 'pending', payment_amount numeric,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());

    INSERT INTO public.availability_slots (id) VALUES ('${S1}'), ('${S2}');

    -- Happy cycle C: I1(player,S1) I2(guest,S1) I3(guest,S2) proposed+assigned; I4(player) proposed,
    -- NO assignment; I5(player) status 'new' (must NOT be claimed).
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

    -- Rollback cycle R: R1 → stale slot SX (booking INSERT fails), R2 → valid S1.
    INSERT INTO public.intake_requests (id, cycle_id, status, player_id, guest_player_id) VALUES
      ('00000000-0000-0000-0000-0000000e0011', '${R}', 'proposed', '${P1}', NULL),
      ('00000000-0000-0000-0000-0000000e0012', '${R}', 'proposed', '${P4}', NULL);
    INSERT INTO public.proposed_assignments (intake_request_id, slot_id, status) VALUES
      ('00000000-0000-0000-0000-0000000e0011', '${SX}', 'proposed'),
      ('00000000-0000-0000-0000-0000000e0012', '${S1}', 'proposed');
  `);

  // Apply the ACTUAL migration.
  await db.exec(readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260701120000_finalize_cycle_proposals_rpc.sql'), 'utf8'));
});

describe('finalize_cycle_proposals (atomic, against real Postgres)', () => {
  it('happy path: claims all proposed intakes, books one per assignment, confirms assignments', async () => {
    const res = await finalize(C);
    expect(res.booked_intakes).toBe(4); // all 4 proposed (not the 'new' one)
    expect(res.bookings).toHaveLength(3); // one per assignment; the assignment-less intake makes none

    expect(await count(`SELECT count(*)::int n FROM public.intake_requests WHERE cycle_id=$1 AND status='booked'`, [C])).toBe(4);
    expect(await count(`SELECT count(*)::int n FROM public.intake_requests WHERE cycle_id=$1 AND status='new'`, [C])).toBe(1); // 'new' untouched
    expect(await count(`SELECT count(*)::int n FROM public.proposed_assignments WHERE status='confirmed'`)).toBe(3);
    expect(await count(`SELECT count(*)::int n FROM public.bookings WHERE slot_id=$1`, [S1])).toBe(2); // shared slot
    expect(await count(`SELECT count(*)::int n FROM public.bookings WHERE guest_player_id=$1 AND slot_id=$2`, [G2, S1])).toBe(1);
    expect(await count(`SELECT count(*)::int n FROM public.bookings WHERE status='confirmed' AND payment_status='pending'`)).toBe(3);
  });

  it('re-run is idempotent: claims zero, creates no duplicate bookings', async () => {
    const rerun = await finalize(C);
    expect(rerun.booked_intakes).toBe(0);
    expect(rerun.bookings).toHaveLength(0);
    expect(await count(`SELECT count(*)::int n FROM public.bookings`)).toBe(3); // still 3, no dupes
  });

  it('empty cycle: no claims, no bookings', async () => {
    const empty = await finalize(EMPTY);
    expect(empty.booked_intakes).toBe(0);
    expect(empty.bookings).toHaveLength(0);
  });

  it('ATOMICITY: a failing booking INSERT rolls the WHOLE call back (no orphaned booked intake)', async () => {
    await expect(finalize(R)).rejects.toThrow(); // the stale-slot booking raises

    // The claim must have rolled back: both R intakes stay 'proposed', none orphaned as 'booked',
    // no R assignment confirmed, and no partial booking exists (still only the 3 from cycle C).
    expect(await count(`SELECT count(*)::int n FROM public.intake_requests WHERE cycle_id=$1 AND status='proposed'`, [R])).toBe(2);
    expect(await count(`SELECT count(*)::int n FROM public.intake_requests WHERE cycle_id=$1 AND status='booked'`, [R])).toBe(0);
    expect(await count(
      `SELECT count(*)::int n FROM public.proposed_assignments pa
         JOIN public.intake_requests ir ON ir.id = pa.intake_request_id
        WHERE ir.cycle_id=$1 AND pa.status='confirmed'`, [R])).toBe(0);
    expect(await count(`SELECT count(*)::int n FROM public.bookings`)).toBe(3); // no partial write from R
  });
});
