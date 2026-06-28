// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Correctness test for `syncInvoicesAfterCycleEdit` — the cyclus-edit "Write B" recalc. PR-1b
// extracted the bespoke recalc verbatim and PINNED bugs B1–B5; PR-3 deleted that body and routes
// through the canonical `syncInvoicesAfterPriceChange` resync, so these assertions now encode the
// CORRECT billing: line items rebuilt from the real bookings, split read from invoices.split_count,
// total === subtotal + vat, stale vat_breakdown cleared. Runs the REAL canonical pipeline against
// real Postgres (PGlite). See docs/audits/TSO_INVOICE_WRITES_AUDIT.md (Write B).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';

// The canonical resync binds the `@/lib/supabaseClient` singleton (not injectable), so route it to a
// PGlite-backed adapter — the ACTUAL recalc runs against real SQL. (Same pattern as invoiceSync.pglite.test.ts.)
const h = vi.hoisted(() => ({ supa: null as ReturnType<typeof createPgliteSupabase> | null }));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: new Proxy(
    {},
    { get: (_t, prop: string) => (h.supa as unknown as Record<string, unknown>)?.[prop] },
  ),
}));

import { syncInvoicesAfterCycleEdit } from '@/lib/cycleEditInvoiceSync';

let db: PGlite;

const invRow = async (id = 'INV1') =>
  (await db.query<{
    line_items: Array<Record<string, unknown>>;
    subtotal: string; vat_amount: string; total: string;
    vat_breakdown: Record<string, unknown> | null; status: string;
  }>(
    `SELECT line_items, subtotal, vat_amount, total, vat_breakdown, status FROM invoices WHERE id = $1`,
    [id],
  )).rows[0];

const num = (s: string) => Number(s);
const round2 = (n: number) => Math.round(n * 100) / 100;

beforeAll(async () => {
  db = new PGlite();
  h.supa = createPgliteSupabase(db);
  await db.exec(`
    CREATE TABLE locations (id text PRIMARY KEY, name text);
    CREATE TABLE cycles (id text PRIMARY KEY, settings jsonb);
    CREATE TABLE availability_slots (
      id text PRIMARY KEY, price_per_session numeric, cyclus_id text, cyclus_name text,
      start_time timestamptz, prices_include_vat boolean, extra_costs jsonb, location_id text);
    CREATE TABLE bookings (id text PRIMARY KEY, slot_id text, payment_amount numeric, status text);
    CREATE TABLE invoices (
      id text PRIMARY KEY, invoice_number text, booking_ids text[], line_items jsonb,
      subtotal numeric, vat_amount numeric, total numeric, status text, vat_rate numeric,
      split_count int, pdf_url text, vat_breakdown jsonb, notes text,
      updated_at timestamptz DEFAULT now());
    CREATE FUNCTION bump_updated_at() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN NEW.updated_at = clock_timestamp(); RETURN NEW; END; $$;
    CREATE TRIGGER trg_inv_updated BEFORE UPDATE ON invoices
      FOR EACH ROW EXECUTE FUNCTION bump_updated_at();
    INSERT INTO locations VALUES ('L1', 'Court A');
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM bookings; DELETE FROM invoices; DELETE FROM availability_slots; DELETE FROM cycles;`);
});

// Seed one cyclus 'C1' (settings vary) + one exclusive-VAT slot 'S1' at `price`.
const seedCycle = async (price: number, settings = '{}', incVat = false) => {
  await db.query(`INSERT INTO cycles VALUES ('C1', $1::jsonb)`, [settings]);
  await db.query(
    `INSERT INTO availability_slots (id, price_per_session, cyclus_id, cyclus_name, start_time, prices_include_vat, extra_costs, location_id)
     VALUES ('S1', $1, 'C1', 'Zomertraining', '2026-07-06 18:00:00+00', $2, '[]'::jsonb, 'L1')`,
    [price, incVat],
  );
};

describe('syncInvoicesAfterCycleEdit — canonical recalc (bugs B1–B5 + TOCTOU fixed)', () => {
  it('B1: line items are REBUILT from the real bookings (not line[0]-kept); total = subtotal + vat', async () => {
    await seedCycle(10);
    await db.exec(`
      INSERT INTO bookings (id, slot_id, payment_amount, status) VALUES ('B1','S1',NULL,'confirmed'), ('B2','S1',NULL,'confirmed');
      INSERT INTO invoices (id, invoice_number, booking_ids, line_items, subtotal, vat_amount, total, status, vat_rate, split_count)
        VALUES ('INV1','2026-001', ARRAY['B1','B2'],
          '[{"description":"Sessie week 1","quantity":1,"unit_price":10},{"description":"Sessie week 2","quantity":1,"unit_price":10},{"description":"Handmatige korting","quantity":1,"unit_price":-5}]'::jsonb,
          0, 0, 12.1, 'sent', 21, 1);
    `);

    await syncInvoicesAfterCycleEdit('C1');

    const inv = await invRow();
    // Rebuilt from the 2 real bookings @ €10 → one consolidated session line (the stale 3 lines,
    // incl. the manual discount, are gone — consistent with every other cycle-price-edit path).
    expect(num(inv.subtotal)).toBe(20);
    expect(num(inv.vat_amount)).toBe(4.2);
    expect(num(inv.total)).toBe(24.2);
    expect(num(inv.total)).toBe(round2(num(inv.subtotal) + num(inv.vat_amount)));
  });

  it('B2: split share is read from invoices.split_count (no marker needed) — not re-billed at FULL', async () => {
    await seedCycle(50);
    await db.exec(`
      INSERT INTO bookings (id, slot_id, payment_amount, status) VALUES ('B1','S1',NULL,'confirmed');
      -- split_count = 2, but the line carries NO "(1/2)" marker text (the old B2 trigger).
      INSERT INTO invoices (id, invoice_number, booking_ids, line_items, subtotal, vat_amount, total, status, vat_rate, split_count)
        VALUES ('INV1','2026-002', ARRAY['B1'], '[{"description":"Sessie","quantity":1,"unit_price":25}]'::jsonb,
          0, 0, 0, 'sent', 21, 2);
    `);

    await syncInvoicesAfterCycleEdit('C1');

    const inv = await invRow();
    // applySplit(50, 2) = 25 → the player is billed their 1/2 share, NOT the full €50 (the old N× overcharge).
    expect(num(inv.subtotal)).toBe(25);
    expect(num(inv.total)).toBe(round2(num(inv.subtotal) + num(inv.vat_amount)));
  });

  it('B3: exclusive multi-rate total is internally consistent (total === subtotal + vat, no 1¢ drift)', async () => {
    // The audit example: €0.01 @21% (session) + €13.81 @9% (extra cost), VAT-exclusive.
    await seedCycle(0.01, JSON.stringify({ extra_costs: [{ description: 'Materiaal', price: 13.81, type: 'one_time', vat_rate: 9 }] }));
    await db.exec(`
      INSERT INTO bookings (id, slot_id, payment_amount, status) VALUES ('B1','S1',NULL,'confirmed');
      INSERT INTO invoices (id, invoice_number, booking_ids, line_items, subtotal, vat_amount, total, status, vat_rate, split_count)
        VALUES ('INV1','2026-003', ARRAY['B1'], '[]'::jsonb, 0, 0, 0, 'sent', 21, 1);
    `);

    await syncInvoicesAfterCycleEdit('C1');

    const inv = await invRow();
    expect(num(inv.subtotal)).toBe(13.82);
    expect(num(inv.vat_amount)).toBe(1.24);
    // Canonical: total = round2(subtotal + vat) = 15.06 (the bespoke produced 15.07 ≠ subtotal+vat).
    expect(num(inv.total)).toBe(15.06);
    expect(num(inv.total)).toBe(round2(num(inv.subtotal) + num(inv.vat_amount)));
  });

  it('B4: a single-rate result CLEARS any stale multi-rate vat_breakdown', async () => {
    await seedCycle(10);
    await db.exec(`
      INSERT INTO bookings (id, slot_id, payment_amount, status) VALUES ('B1','S1',NULL,'confirmed');
      INSERT INTO invoices (id, invoice_number, booking_ids, line_items, subtotal, vat_amount, total, status, vat_rate, split_count, vat_breakdown)
        VALUES ('INV1','2026-004', ARRAY['B1'], '[]'::jsonb, 0, 0, 0, 'sent', 21, 1,
          '{"9":{"subtotal":5,"vat":0.45},"21":{"subtotal":10,"vat":2.1}}'::jsonb);
    `);

    await syncInvoicesAfterCycleEdit('C1');

    const inv = await invRow();
    // Single-rate (one 21% session line) → the stale "9"/"21" breakdown is cleared, not left to mis-render the PDF.
    expect(inv.vat_breakdown).toBeNull();
  });

  it('a paid invoice is excluded (status not in sent/draft/overdue) and never recalculated', async () => {
    await seedCycle(10);
    await db.exec(`
      INSERT INTO bookings (id, slot_id, payment_amount, status) VALUES ('B1','S1',NULL,'confirmed');
      INSERT INTO invoices (id, invoice_number, booking_ids, line_items, subtotal, vat_amount, total, status, vat_rate, split_count)
        VALUES ('INV1','2026-005', ARRAY['B1'], '[]'::jsonb, 99, 0, 99, 'paid', 21, 1);
    `);

    await syncInvoicesAfterCycleEdit('C1');

    const inv = await invRow();
    expect(num(inv.total)).toBe(99); // untouched
    expect(inv.status).toBe('paid');
  });
});
