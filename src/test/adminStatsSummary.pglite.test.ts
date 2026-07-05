// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// P2-16: get-admin-stats used to pull whole tables through PostgREST's 1000-row cap and aggregate in
// JS, so GMV/counts/trends were silently wrong past 1000 bookings. This runs the REAL
// admin_stats_summary() migration against real Postgres over a >1000-row dataset and proves the SQL
// aggregation equals the JS reference computed over the FULL array (and does NOT equal the
// 1000-row-capped value the old path would have produced). It also proves the admin gate
// (has_role(auth.uid(),'admin')) refuses a non-admin caller.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

// The single admin caller. has_role() is stubbed true for this uuid, false otherwise.
// auth.uid() is stubbed to read the 'app.test_uid' session GUC, which each call sets.
const ADMIN = '00000000-0000-0000-0000-0000000000aa';
const NON_ADMIN = '00000000-0000-0000-0000-0000000000bb';

function readMigration(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  return readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260706130200_p2_16_admin_stats_summary.sql'), 'utf8');
}

// UTC month boundaries mirroring the edge fn (Deno runs in UTC).
const now = new Date();
const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

interface B { payment_status: string; payment_amount: number; paid_at: string | null; created_at: string; }
const bookings: B[] = [];
// Seed 1500 paid bookings (> the 1000 PostgREST cap) with distinct amounts + 200 unpaid.
for (let i = 0; i < 1500; i++) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (i % 6), 1, 12));
  bookings.push({ payment_status: 'paid', payment_amount: 10 + (i % 7), paid_at: d.toISOString(), created_at: d.toISOString() });
}
for (let i = 0; i < 200; i++) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12));
  bookings.push({ payment_status: 'pending', payment_amount: 99, paid_at: null, created_at: d.toISOString() });
}

function monthKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// JS reference over the FULL array (what the numbers SHOULD be).
const paid = bookings.filter((b) => b.payment_status === 'paid');
const refGMV = paid.reduce((s, b) => s + b.payment_amount, 0);
const refMonthly: Record<string, { gmv: number; bookings: number }> = {};
for (const b of paid) {
  const k = monthKey(b.paid_at ?? b.created_at);
  refMonthly[k] = refMonthly[k] || { gmv: 0, bookings: 0 };
  refMonthly[k].gmv += b.payment_amount;
  refMonthly[k].bookings += 1;
}
// What the OLD capped path would have produced (first 1000 rows only).
const cappedPaid = bookings.slice(0, 1000).filter((b) => b.payment_status === 'paid');
const cappedGMV = cappedPaid.reduce((s, b) => s + b.payment_amount, 0);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE SCHEMA IF NOT EXISTS auth;
    -- auth.uid() stub: reads a settable session GUC so the test can impersonate a caller.
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT NULLIF(current_setting('app.test_uid', true), '')::uuid $fn$;
    -- admin gate stub: true only for the ADMIN uuid.
    CREATE FUNCTION public.has_role(_uid uuid, _role text) RETURNS boolean LANGUAGE sql STABLE AS $fn$
      SELECT _uid = '${ADMIN}'::uuid $fn$;

    CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_status text, payment_amount numeric, paid_at timestamptz, created_at timestamptz);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      subscription_status text, created_at timestamptz DEFAULT now());
    CREATE TABLE public.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now());
    CREATE TABLE public.trainer_mollie_accounts (trainer_id uuid, charges_enabled boolean);
    CREATE TABLE public.club_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      is_verified boolean DEFAULT false, subscription_status text, trial_ends_at timestamptz);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      linked_profile_id uuid, has_trained boolean DEFAULT false, created_at timestamptz DEFAULT now());
  `);
  await db.exec(readMigration());

  // Bulk-insert bookings.
  const values = bookings
    .map((b) => `('${b.payment_status}', ${b.payment_amount}, ${b.paid_at ? `'${b.paid_at}'` : 'NULL'}, '${b.created_at}')`)
    .join(',');
  await db.exec(`INSERT INTO public.bookings (payment_status, payment_amount, paid_at, created_at) VALUES ${values};`);

  // Trainers: 3 professional, 2 academy, 1 starter (null). One created this month, one last month.
  await db.exec(`
    INSERT INTO public.trainer_profiles (subscription_status, created_at) VALUES
      ('professional', '${thisMonthStart.toISOString()}'),
      ('active', now()),
      ('professional', now()),
      ('academy', now()),
      ('academy', now()),
      (NULL, '${lastMonthStart.toISOString()}');
    INSERT INTO public.profiles (created_at) VALUES ('${thisMonthStart.toISOString()}'), (now()), ('${lastMonthStart.toISOString()}');
    INSERT INTO public.trainer_mollie_accounts (trainer_id, charges_enabled) VALUES
      (gen_random_uuid(), true), (gen_random_uuid(), true), (gen_random_uuid(), false);
    INSERT INTO public.guest_players (linked_profile_id, has_trained, created_at) VALUES
      (gen_random_uuid(), true, '${thisMonthStart.toISOString()}'),
      (NULL, false, '${lastMonthStart.toISOString()}'),
      (NULL, true, now());
  `);
});

async function summary(caller = ADMIN): Promise<Record<string, unknown>> {
  // Impersonate the caller for auth.uid() inside the SECURITY DEFINER fn.
  await db.exec(`SELECT set_config('app.test_uid', '${caller}', false);`);
  const rows = (await db.query<{ admin_stats_summary: Record<string, unknown> }>(
    `SELECT public.admin_stats_summary() AS admin_stats_summary`,
  )).rows;
  return rows[0].admin_stats_summary;
}

describe('admin_stats_summary() (P2-16)', () => {
  it('computes true totals over the FULL >1000-row dataset (not the capped subset)', async () => {
    const s = await summary();
    expect(Number(s.overview.totalGMV)).toBeCloseTo(refGMV, 2);
    expect(Number(s.overview.paidBookings)).toBe(paid.length);
    expect(Number(s.overview.totalBookings)).toBe(bookings.length);
    // The old 1000-row-capped path would have under-counted GMV — prove the RPC is NOT that value.
    expect(Number(s.overview.totalGMV)).not.toBeCloseTo(cappedGMV, 2);
    expect(paid.length).toBeGreaterThan(1000);
  });

  it('matches the JS per-month gmv+bookings for the last 6 UTC months', async () => {
    const s = await summary();
    for (let i = 5; i >= 0; i--) {
      const md = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const key = `${md.getUTCFullYear()}-${String(md.getUTCMonth() + 1).padStart(2, '0')}`;
      const ref = refMonthly[key] || { gmv: 0, bookings: 0 };
      const got = s.monthly[key] || { gmv: 0, bookings: 0 };
      expect(Number(got.gmv)).toBeCloseTo(ref.gmv, 2);
      expect(Number(got.bookings)).toBe(ref.bookings);
    }
  });

  it('reproduces tier buckets, trends and registration counts', async () => {
    const s = await summary();
    expect(s.trainersByTier).toEqual({ starter: 1, professional: 3, academy: 2 });
    expect(Number(s.overview.activeTrainers)).toBe(6);
    expect(Number(s.overview.connectedAccounts)).toBe(2);
    expect(Number(s.overview.pendingAccounts)).toBe(1);
    expect(Number(s.signupTrends.trainersThisMonth)).toBe(5); // 4 now + 1 at thisMonthStart
    expect(Number(s.signupTrends.trainersLastMonth)).toBe(1);
    expect(Number(s.registrations.totalGuests)).toBe(3);
    expect(Number(s.registrations.convertedToAccount)).toBe(1);
    expect(Number(s.registrations.hasTrained)).toBe(2);
    expect(Number(s.registrations.thisMonth)).toBe(2); // one at thisMonthStart + one now()
    expect(Number(s.registrations.lastMonth)).toBe(1);
  });

  it('is admin-gated — a non-admin caller (auth.uid()) is refused', async () => {
    await expect(summary(NON_ADMIN)).rejects.toThrow(/forbidden/);
  });
});
