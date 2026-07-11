// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';

// The real lib imports `@/lib/supabaseClient`; route it to a PGlite-backed adapter so the ACTUAL
// recalc/cancel logic runs against real Postgres SQL (not a JS mock). vi.hoisted holds the live
// adapter that beforeAll assigns once PGlite has booted.
const h = vi.hoisted(() => ({ supa: null as ReturnType<typeof createPgliteSupabase> | null }));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: new Proxy(
    {},
    { get: (_t, prop: string) => (h.supa as unknown as Record<string, unknown>)?.[prop] },
  ),
}));

import { syncInvoicesAfterBookingRemoval, recalculateInvoiceAfterRemoval, syncInvoicesAfterPriceChange } from '@/lib/invoiceSync';
import { cancelBookingsAndSync } from '@/lib/bookings';

let db: PGlite;
const invRow = async () =>
  (await db.query<{ booking_ids: string[]; total: string; status: string }>(
    `SELECT booking_ids, total, status FROM invoices WHERE id = 'INV1'`,
  )).rows[0];

beforeAll(async () => {
  db = new PGlite();
  h.supa = createPgliteSupabase(db);
  await db.exec(`
    CREATE TABLE locations (id text PRIMARY KEY, name text);
    CREATE TABLE cycles (id text PRIMARY KEY, settings jsonb);
    CREATE TABLE availability_slots (
      id text PRIMARY KEY, price_per_session numeric, cyclus_id text, cyclus_name text,
      start_time timestamptz, prices_include_vat boolean, extra_costs jsonb, location_id text);
    CREATE TABLE bookings (id text PRIMARY KEY, slot_id text, payment_amount numeric, status text, payment_status text);
    CREATE TABLE invoices (
      id text PRIMARY KEY, invoice_number text, booking_ids text[], line_items jsonb,
      subtotal numeric, vat_amount numeric, total numeric, status text, vat_rate numeric,
      split_count int, pdf_url text, vat_breakdown jsonb, notes text,
      cycle_id text, updated_at timestamptz DEFAULT now());
    CREATE FUNCTION bump_updated_at() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN NEW.updated_at = clock_timestamp(); RETURN NEW; END; $$;
    CREATE TRIGGER trg_inv_updated BEFORE UPDATE ON invoices
      FOR EACH ROW EXECUTE FUNCTION bump_updated_at();

    INSERT INTO locations VALUES ('L1', 'Court A');
    INSERT INTO cycles VALUES ('C1', '{}'::jsonb);
    INSERT INTO availability_slots (id, price_per_session, cyclus_id, cyclus_name, start_time, prices_include_vat, extra_costs, location_id)
      VALUES ('S1', 50, 'C1', 'Zomertraining', '2026-07-06 18:00:00+00', true, '[]'::jsonb, 'L1');
  `);
});

// Fresh 2-booking, €100, unpaid invoice before each test.
beforeEach(async () => {
  await db.exec(`
    DELETE FROM bookings; DELETE FROM invoices;
    INSERT INTO bookings (id, slot_id, payment_amount, status) VALUES
      ('B1', 'S1', NULL, 'confirmed'), ('B2', 'S1', NULL, 'confirmed');
    INSERT INTO invoices (id, invoice_number, booking_ids, line_items, subtotal, vat_amount, total, status, vat_rate, split_count)
      VALUES ('INV1', '2026-001', ARRAY['B1','B2'], '[]'::jsonb, 0, 0, 100, 'draft', 21, 1);
  `);
});

describe('booking cancel → invoice reconciliation (against real Postgres)', () => {
  it('REGRESSION baseline: a raw soft-cancel (no facade) leaves the invoice still billing the cancelled booking', async () => {
    await db.query(`UPDATE bookings SET status = 'cancelled' WHERE id = 'B1'`);
    const inv = await invRow();
    expect(inv.booking_ids).toEqual(['B1', 'B2']); // orphaned — still on the invoice
    expect(Number(inv.total)).toBe(100); // player still billed €100 for a cancelled session
  });

  it('cancelBookingsAndSync removes the booking AND rebuilds the invoice (no stale billing)', async () => {
    const res = await cancelBookingsAndSync(['B1']);
    expect(res.cancelError).toBeNull();
    expect(res.syncError).toBeNull();

    const b1 = (await db.query<{ status: string }>(`SELECT status FROM bookings WHERE id = 'B1'`)).rows[0];
    expect(b1.status).toBe('cancelled'); // soft-cancelled, not deleted

    const inv = await invRow();
    expect(inv.booking_ids).toEqual(['B2']); // orphan removed
    expect(Number(inv.total)).toBe(50); // rebuilt to the one remaining session
    expect(inv.status).toBe('draft'); // still open
  });

  it('removing every booking cancels the invoice (total 0, empty booking_ids)', async () => {
    await syncInvoicesAfterBookingRemoval(['B1', 'B2']);
    const inv = await invRow();
    expect(inv.status).toBe('cancelled');
    expect(inv.booking_ids).toEqual([]);
    expect(Number(inv.total)).toBe(0);
  });

  it('split-cycle: removing one player keeps the others on their 1/N share (no overcharge)', async () => {
    // split_count=2 → each booking bills slot_price/2 = €25; two bookings = €50 total.
    await db.exec(`
      DELETE FROM bookings; DELETE FROM invoices;
      INSERT INTO bookings (id, slot_id, payment_amount, status) VALUES
        ('B1', 'S1', NULL, 'confirmed'), ('B2', 'S1', NULL, 'confirmed');
      INSERT INTO invoices (id, invoice_number, booking_ids, line_items, subtotal, vat_amount, total, status, vat_rate, split_count)
        VALUES ('INV1', '2026-002', ARRAY['B1','B2'], '[]'::jsonb, 0, 0, 50, 'draft', 21, 2);
    `);
    await recalculateInvoiceAfterRemoval({ id: 'INV1' }, ['B1']);
    const inv = await invRow();
    expect(inv.booking_ids).toEqual(['B2']);
    expect(Number(inv.total)).toBe(25); // remaining player keeps their 1/2 share — not re-inflated
  });
});

describe('registration invoice (cycle_id set) is never repriced from slot prices (audit Theme 12)', () => {
  const regInvTotal = async (): Promise<number> =>
    Number((await db.query<{ total: string }>(`SELECT total FROM invoices WHERE id = 'REG1'`)).rows[0].total);

  beforeEach(async () => {
    // A sign-up invoice: total is the €80 registration fee (overlay price), cycle_id set. finalize
    // has merged the training booking B1 onto it, so it now overlaps a slot the price-sync touches.
    await db.exec(`
      DELETE FROM bookings; DELETE FROM invoices;
      INSERT INTO bookings (id, slot_id, payment_amount, status) VALUES ('B1', 'S1', NULL, 'confirmed');
      INSERT INTO invoices (id, invoice_number, booking_ids, line_items, subtotal, vat_amount, total, status, vat_rate, split_count, cycle_id)
        VALUES ('REG1', '2026-R01', ARRAY['B1'], '[]'::jsonb, 0, 0, 80, 'sent', 21, 1, 'C1');
    `);
  });

  it('a slot-price change does NOT re-total it from the slot price (stays the €80 registration fee)', async () => {
    await syncInvoicesAfterPriceChange(['S1']);
    expect(await regInvTotal()).toBe(80); // NOT rebuilt to 1×€50 slot price
  });

  it('cancelling one of its merged bookings does NOT rebuild it either', async () => {
    await syncInvoicesAfterBookingRemoval(['B1']);
    expect(await regInvTotal()).toBe(80); // untouched — the overlay fee, not per-booking
  });

  it('CONTROL: a booking invoice (cycle_id NULL) with the same overlap IS still rebuilt', async () => {
    await db.exec(`
      INSERT INTO bookings (id, slot_id, payment_amount, status) VALUES ('B2', 'S1', NULL, 'confirmed');
      INSERT INTO invoices (id, invoice_number, booking_ids, line_items, subtotal, vat_amount, total, status, vat_rate, split_count, cycle_id)
        VALUES ('BOOK1', '2026-B01', ARRAY['B2'], '[]'::jsonb, 0, 0, 999, 'sent', 21, 1, NULL);
    `);
    await syncInvoicesAfterPriceChange(['S1']);
    const bookInv = Number((await db.query<{ total: string }>(`SELECT total FROM invoices WHERE id = 'BOOK1'`)).rows[0].total);
    expect(bookInv).toBe(50); // repriced to the slot — proves the skip is scoped to cycle_id invoices only
    expect(await regInvTotal()).toBe(80); // and the registration invoice beside it is still untouched
  });
});
