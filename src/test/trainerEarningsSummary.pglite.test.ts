// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// GOLDEN anti-divergence test for the get_trainer_earnings_summary RPC
// (20260702150000_get_trainer_earnings_summary.sql). The RPC moves the TrainerEarnings headline
// aggregation server-side; this test runs the ACTUAL migration against real Postgres (PGlite) and
// asserts its output equals the canonical JS helpers in src/lib/trainerEarnings.ts on the SAME data —
// so the SQL can never silently diverge from the page's money math.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { computeEarningsSummary, type EarningsBookingLike } from '@/lib/trainerEarnings';

let db: PGlite;

const USER = '10000000-0000-0000-0000-000000000001'; // the calling user (auth.uid())
const TRAINER = '20000000-0000-0000-0000-000000000001'; // their trainer_profiles.id
const OTHER = '20000000-0000-0000-0000-0000000000ff'; // a different trainer (must be excluded)

// Month windows (browser-local in prod; fixed here). July 2026 = "this month", June = "last".
const TMS = '2026-07-01T00:00:00.000Z', TME = '2026-07-31T23:59:59.999Z';
const LMS = '2026-06-01T00:00:00.000Z', LME = '2026-06-30T23:59:59.999Z';

// Each seeded booking, mirrored as the JS shape the page builds (slot price under availability_slots).
type Seed = { slotPrice: number; trainer: string; status: string; payment_status: string; paid_at: string | null; payment_amount: number | null };
const SEEDS: Seed[] = [
  { slotPrice: 50, trainer: TRAINER, status: 'completed', payment_status: 'paid', paid_at: '2026-07-10T12:00:00Z', payment_amount: 50 },   // this-month paid
  { slotPrice: 40, trainer: TRAINER, status: 'completed', payment_status: 'paid', paid_at: '2026-06-15T12:00:00Z', payment_amount: null }, // last-month paid, amount←slot (40)
  { slotPrice: 30, trainer: TRAINER, status: 'confirmed', payment_status: 'paid', paid_at: '2026-05-01T12:00:00Z', payment_amount: 0 },    // older paid, amount←slot (0 falls through)
  { slotPrice: 25, trainer: TRAINER, status: 'cancelled', payment_status: 'paid', paid_at: '2026-07-20T12:00:00Z', payment_amount: 25 },   // cancelled-but-paid still counts in total + this-month
  { slotPrice: 60, trainer: TRAINER, status: 'completed', payment_status: 'pending', paid_at: null, payment_amount: 60 },                  // pending → pending_amount
  { slotPrice: 70, trainer: TRAINER, status: 'confirmed', payment_status: 'invoiced', paid_at: null, payment_amount: null },               // invoiced → pending_amount, amount←slot (70)
  { slotPrice: 99, trainer: TRAINER, status: 'completed', payment_status: 'paid', paid_at: null, payment_amount: 99 },                     // 'paid' but no paid_at → NOT received
  { slotPrice: 80, trainer: OTHER, status: 'completed', payment_status: 'paid', paid_at: '2026-07-05T12:00:00Z', payment_amount: 80 },     // other trainer → excluded
  { slotPrice: 90, trainer: TRAINER, status: 'attended', payment_status: 'paid', paid_at: '2026-07-06T12:00:00Z', payment_amount: 90 },    // status not in the loaded set → excluded
  { slotPrice: 15, trainer: TRAINER, status: 'cancelled', payment_status: 'pending', paid_at: null, payment_amount: 15 },                  // in the loaded set but cancelled+pending → counts toward NEITHER total NOR pending (hardens the status filter)
];

// The JS shape the page would load (only the TRAINER's bookings whose status is in the loaded set).
const jsBookings: EarningsBookingLike[] = SEEDS
  .filter((s) => s.trainer === TRAINER && ['completed', 'confirmed', 'cancelled'].includes(s.status))
  .map((s) => ({
    status: s.status,
    payment_status: s.payment_status,
    paid_at: s.paid_at,
    payment_amount: s.payment_amount,
    availability_slots: { price_per_session: s.slotPrice },
  }));

// The page's exact aggregation, via the SAME canonical helper the page's fallback path uses.
const js = computeEarningsSummary(jsBookings, {
  thisStart: new Date(TMS), thisEnd: new Date(TME), lastStart: new Date(LMS), lastEnd: new Date(LME),
});

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT '${USER}'::uuid $fn$;
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, trainer_id uuid, price_per_session numeric);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, status text,
      payment_status text, paid_at timestamptz, payment_amount numeric);
    INSERT INTO public.trainer_profiles VALUES ('${TRAINER}', '${USER}');
  `);
  // One slot per seed (carries the trainer + slot price), one booking per seed.
  for (let i = 0; i < SEEDS.length; i++) {
    const s = SEEDS[i];
    const slot = `30000000-0000-0000-0000-0000000000${(i + 10).toString(16).padStart(2, '0')}`;
    await db.query(`INSERT INTO public.availability_slots VALUES ($1, $2, $3)`, [slot, s.trainer, s.slotPrice]);
    await db.query(
      `INSERT INTO public.bookings (slot_id, status, payment_status, paid_at, payment_amount) VALUES ($1,$2,$3,$4,$5)`,
      [slot, s.status, s.payment_status, s.paid_at, s.payment_amount]);
  }
  // Apply the ACTUAL migration (the RPC under test).
  await db.exec(readMigration());
});

function readMigration(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  return readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260702150000_get_trainer_earnings_summary.sql'), 'utf8');
}

describe('get_trainer_earnings_summary RPC == canonical trainerEarnings.ts (golden)', () => {
  it('the SQL aggregation matches the JS helpers on the same data', async () => {
    const r = (await db.query<{
      total_earnings: string; this_month: string; last_month: string;
      pending_amount: string; pending_count: number; completed_paid_count: number;
    }>(`SELECT * FROM public.get_trainer_earnings_summary($1,$2,$3,$4)`, [TMS, TME, LMS, LME])).rows[0];

    expect(Number(r.total_earnings)).toBeCloseTo(js.total, 2);     // 50 + 40 + 30 + 25 = 145
    expect(Number(r.this_month)).toBeCloseTo(js.thisMonth, 2);     // 50 + 25 = 75
    expect(Number(r.last_month)).toBeCloseTo(js.lastMonth, 2);     // 40
    expect(Number(r.pending_amount)).toBeCloseTo(js.pending, 2);   // 60 + 70 = 130
    // Counts also match the JS reference: 2 pending (pending + invoiced); 3 completed+paid.
    expect(Number(r.pending_count)).toBe(js.pendingCount);
    expect(Number(r.completed_paid_count)).toBe(js.completedPaidCount);
    expect(js.pendingCount).toBe(2);
    expect(js.completedPaidCount).toBe(3);

    // Sanity: the hand-computed expectations the JS should also produce (guards a silent helper change).
    expect(js.total).toBe(145);
    expect(js.thisMonth).toBe(75);
    expect(js.lastMonth).toBe(40);
    expect(js.pending).toBe(130);
  });

  it('returns zeros for a user with no trainer profile (no IDOR, safe default)', async () => {
    // Swap auth.uid() to an unknown user → v_trainer_id NULL → all-zero row.
    await db.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT '99999999-9999-9999-9999-999999999999'::uuid $fn$;`);
    const r = (await db.query<{ total_earnings: string; pending_count: number }>(
      `SELECT * FROM public.get_trainer_earnings_summary($1,$2,$3,$4)`, [TMS, TME, LMS, LME])).rows[0];
    expect(Number(r.total_earnings)).toBe(0);
    expect(Number(r.pending_count)).toBe(0);
    await db.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT '${USER}'::uuid $fn$;`);
  });
});
