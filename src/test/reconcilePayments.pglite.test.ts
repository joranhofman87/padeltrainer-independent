// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Phase 5: runs the ACTUAL reconcile_payments() migration (20260705140000) against real Postgres and
// proves (a) it is admin-gated, (b) it is read-only, and (c) each check flags a seeded mismatch while
// leaving clean data alone.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

function readMigration(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  return readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260705140000_reconcile_payments.sql'), 'utf8');
}

async function findings(): Promise<Record<string, number>> {
  const rows = (await db.query<{ check_name: string }>(`SELECT check_name FROM public.reconcile_payments()`)).rows;
  const by: Record<string, number> = {};
  for (const r of rows) by[r.check_name] = (by[r.check_name] ?? 0) + 1;
  return by;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT '00000000-0000-0000-0000-0000000000aa'::uuid $fn$;
    -- Default: the caller IS an admin. A later test swaps this to false.
    CREATE FUNCTION public.has_role(_uid uuid, _role text) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT true $fn$;

    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, mollie_payment_id text, total numeric,
      booking_ids uuid[], rebook_group_id uuid, public_token uuid, paid_at timestamptz, created_at timestamptz DEFAULT now());
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id text, status text, payment_status text,
      payment_amount numeric, hold_expires_at timestamptz, paid_at timestamptz);
  `);
  await db.exec(readMigration());

  // Seed a mix of clean + broken records.
  await db.exec(`
    -- CLEAN: a paid invoice + its paid booking (must NOT be flagged).
    INSERT INTO public.bookings (id, slot_id, status, payment_status, payment_amount, paid_at) VALUES
      ('b0000000-0000-0000-0000-000000000001', 's1', 'confirmed', 'paid', 50, now());
    INSERT INTO public.invoices (id, status, total, booking_ids, public_token, paid_at, created_at) VALUES
      ('a0000000-0000-0000-0000-000000000001', 'paid', 50, ARRAY['b0000000-0000-0000-0000-000000000001']::uuid[], gen_random_uuid(), now(), now());

    -- 1) stranded_invoice: mollie_payment_id set, status 'sent', created 2h ago.
    INSERT INTO public.invoices (id, status, mollie_payment_id, total, created_at) VALUES
      ('a0000000-0000-0000-0000-000000000002', 'sent', 'tr_stuck', 40, now() - interval '2 hours');

    -- 3) cancelled_booking_on_paid_invoice.
    INSERT INTO public.bookings (id, slot_id, status, payment_status) VALUES
      ('b0000000-0000-0000-0000-000000000003', 's3', 'cancelled', 'pending');
    INSERT INTO public.invoices (id, status, total, booking_ids, paid_at, created_at) VALUES
      ('a0000000-0000-0000-0000-000000000003', 'paid', 30, ARRAY['b0000000-0000-0000-0000-000000000003']::uuid[], now(), now());

    -- 4) overlapping_active_invoices: two non-cancelled invoices billing booking b...04.
    INSERT INTO public.bookings (id, slot_id, status, payment_status) VALUES
      ('b0000000-0000-0000-0000-000000000004', 's4', 'confirmed', 'pending');
    INSERT INTO public.invoices (id, status, total, booking_ids, created_at) VALUES
      ('a0000000-0000-0000-0000-000000000041', 'sent', 20, ARRAY['b0000000-0000-0000-0000-000000000004']::uuid[], now()),
      ('a0000000-0000-0000-0000-000000000042', 'sent', 20, ARRAY['b0000000-0000-0000-0000-000000000004']::uuid[], now());

    -- 5) duplicate_rebook_group_invoice.
    INSERT INTO public.invoices (id, status, total, rebook_group_id, created_at) VALUES
      ('a0000000-0000-0000-0000-000000000051', 'sent', 10, 'c0000000-0000-0000-0000-000000000001'::uuid, now()),
      ('a0000000-0000-0000-0000-000000000052', 'sent', 10, 'c0000000-0000-0000-0000-000000000001'::uuid, now());

    -- 6) stale_hold: payment_pending, hold expired 20 min ago.
    INSERT INTO public.bookings (id, slot_id, status, payment_status, hold_expires_at) VALUES
      ('b0000000-0000-0000-0000-000000000006', 's6', 'payment_pending', 'pending', now() - interval '20 minutes');

    -- 7) sent_invoice_no_token.
    INSERT INTO public.invoices (id, status, total, public_token, created_at) VALUES
      ('a0000000-0000-0000-0000-000000000007', 'sent', 25, NULL, now());
  `);
});

describe('reconcile_payments() (Phase 5)', () => {
  it('flags each seeded mismatch and leaves the clean paid invoice+booking alone', async () => {
    const f = await findings();
    expect(f.stranded_invoice).toBeGreaterThanOrEqual(1);
    expect(f.cancelled_booking_on_paid_invoice).toBeGreaterThanOrEqual(1);
    expect(f.overlapping_active_invoices).toBeGreaterThanOrEqual(1);
    expect(f.duplicate_rebook_group_invoice).toBeGreaterThanOrEqual(2); // both rows reported
    expect(f.stale_hold).toBeGreaterThanOrEqual(1);
    expect(f.sent_invoice_no_token).toBeGreaterThanOrEqual(1);
    // The clean paid invoice's booking is paid → not flagged as invoice_paid_bookings_unpaid.
    expect(f.invoice_paid_bookings_unpaid ?? 0).toBe(0);
  });

  it('is READ-ONLY — running it does not mutate any row', async () => {
    const before = (await db.query<{ n: string }>(`SELECT count(*) n FROM public.bookings`)).rows[0].n;
    await db.query(`SELECT * FROM public.reconcile_payments()`);
    const after = (await db.query<{ n: string }>(`SELECT count(*) n FROM public.bookings`)).rows[0].n;
    expect(after).toBe(before);
  });

  it('is admin-gated — a non-admin caller is refused', async () => {
    await db.exec(`CREATE OR REPLACE FUNCTION public.has_role(_uid uuid, _role text) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;`);
    await expect(db.query(`SELECT * FROM public.reconcile_payments()`)).rejects.toThrow(/forbidden/);
    // restore for any later runs
    await db.exec(`CREATE OR REPLACE FUNCTION public.has_role(_uid uuid, _role text) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT true $fn$;`);
  });
});
