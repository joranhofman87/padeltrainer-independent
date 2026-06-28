// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// CHARACTERIZATION test (behaviour-freeze) for `recalcCycleInvoiceTotals` — the "Write B"
// extra-cost/total recalc extracted VERBATIM into src/lib/cycleEditInvoiceSync.ts. Runs the
// REAL helper against real Postgres (PGlite) and PINS TODAY's BUGGY output bit-for-bit so the
// canonical-recalc replacement (PR-3) has a reviewable money diff. Every assertion that encodes
// a KNOWN bug is marked `BUG …:` and cross-referenced to docs/audits/TSO_INVOICE_WRITES_AUDIT.md
// (Write B). When PR-3 lands, these `BUG` assertions flip to canonical values — that flip IS the
// diff.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { recalcCycleInvoiceTotals } from '@/lib/cycleEditInvoiceSync';

let db: PGlite;
let supa: SupabaseClient<Database>;

const CYC = 'cyc-1';
const S1 = 'slot-1';
const B1 = '30000000-0000-0000-0000-0000000000b1'; // one confirmed booking on S1
const INV = 'a0000000-0000-0000-0000-000000000001';
const INV2 = 'a0000000-0000-0000-0000-000000000002';

const invoiceRow = async (id: string) =>
  (await db.query<{
    line_items: Array<Record<string, unknown>>;
    subtotal: string; vat_amount: string; total: string;
    vat_breakdown: Record<string, unknown> | null;
  }>(
    `SELECT line_items, subtotal, vat_amount, total, vat_breakdown FROM invoices WHERE id = $1`,
    [id],
  )).rows[0];

// Seed an unpaid invoice that overlaps booking B1 (so the helper finds it via the cyclus→slot→
// booking→booking_ids chain). line_items/vat_rate/vat_breakdown vary per test.
const seedInvoice = async (
  id: string,
  lineItems: Array<Record<string, unknown>>,
  vatRate = 21,
  vatBreakdown: Record<string, unknown> | null = null,
) => {
  await db.query(
    `INSERT INTO invoices (id, status, booking_ids, line_items, vat_rate, subtotal, vat_amount, total, vat_breakdown, pdf_url)
     VALUES ($1,'sent',ARRAY['${B1}']::uuid[],$2::jsonb,$3,0,0,0,$4::jsonb,'old.pdf')`,
    [id, JSON.stringify(lineItems), vatRate, vatBreakdown ? JSON.stringify(vatBreakdown) : null],
  );
};

beforeAll(async () => {
  db = new PGlite();
  supa = createPgliteSupabase(db) as unknown as SupabaseClient<Database>;
  await db.exec(`
    CREATE TABLE availability_slots (id text PRIMARY KEY, cyclus_id text);
    CREATE TABLE bookings (id uuid PRIMARY KEY, slot_id text, status text);
    CREATE TABLE invoices (
      id uuid PRIMARY KEY, status text, booking_ids uuid[], line_items jsonb,
      vat_rate numeric, subtotal numeric, vat_amount numeric, total numeric,
      vat_breakdown jsonb, pdf_url text
    );
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM invoices; DELETE FROM bookings; DELETE FROM availability_slots;`);
  await db.exec(`INSERT INTO availability_slots VALUES ('${S1}','${CYC}');`);
  await db.exec(`INSERT INTO bookings VALUES ('${B1}','${S1}','confirmed');`);
});

const base = { cyclusId: CYC, cycleName: 'Herfst', pricesIncludeVat: false };

describe('recalcCycleInvoiceTotals — characterization (pins bugs B1/B2/B3/B4)', () => {
  it('B1 (P0): rebuild keeps line_items[0] and DROPS [1..n] (incl. manual lines/discounts)', async () => {
    await seedInvoice(INV, [
      { description: 'Sessie week 1', quantity: 1, unit_price: 10, vat_rate: 21 },
      { description: 'Sessie week 2', quantity: 1, unit_price: 10, vat_rate: 21 },
      { description: 'Handmatige korting', quantity: 1, unit_price: -5, vat_rate: 21 },
    ]);

    await recalcCycleInvoiceTotals({ ...base, sessionPrice: 10, extraCosts: [] }, supa);

    const inv = await invoiceRow(INV);
    // BUG B1: only line[0] survives; week 2 + the manual discount are silently deleted.
    expect(inv.line_items).toHaveLength(1);
    expect(inv.line_items[0].description).toBe('Sessie week 1');
    const descs = inv.line_items.map((l) => l.description);
    expect(descs).not.toContain('Sessie week 2');
    expect(descs).not.toContain('Handmatige korting');
    // Single-rate totals stay self-consistent (B3 only bites exclusive multi-rate).
    expect(Number(inv.subtotal)).toBe(10);
    expect(Number(inv.vat_amount)).toBe(2.1);
    expect(Number(inv.total)).toBe(12.1);
  });

  it('B2 (P0): split count read from the "(1/N)" marker only — unmarked split invoice re-priced at FULL', async () => {
    // INV: a 2-way-split session line (priced at half, €25) but with NO "(1/2)" marker text.
    await seedInvoice(INV, [{ description: 'Sessie', quantity: 1, unit_price: 25, vat_rate: 21 }]);
    // INV2: the SAME split, but correctly marked "(1/2)".
    await seedInvoice(INV2, [{ description: 'Sessie (1/2)', quantity: 1, unit_price: 25, vat_rate: 21 }]);

    await recalcCycleInvoiceTotals({ ...base, sessionPrice: 50, extraCosts: [] }, supa);

    // BUG B2: no marker → splitCount falls back to 1 → the half-price split line is re-billed at
    // the FULL €50 (2× overcharge), ignoring that this is a structural split.
    expect(Number((await invoiceRow(INV)).line_items[0].unit_price)).toBe(50);
    // Marker present → splitCount=2 → re-priced at the correct €25. (Shows the marker-dependence.)
    expect(Number((await invoiceRow(INV2)).line_items[0].unit_price)).toBe(25);
  });

  it('B3 (P1): exclusive multi-rate total diverges from subtotal+vat_amount by 1 cent', async () => {
    // The audit worked example: €0.01 @21% (session) + €13.81 @9% (extra), VAT-exclusive.
    await seedInvoice(INV, [{ description: 'Sessie', quantity: 1, unit_price: 5, vat_rate: 21 }], 21);

    await recalcCycleInvoiceTotals(
      { ...base, sessionPrice: 0.01, extraCosts: [{ description: 'Materiaal', price: 13.81, type: 'one_time', vat_rate: 9 }] },
      supa,
    );

    const inv = await invoiceRow(INV);
    expect(Number(inv.subtotal)).toBe(13.82);
    expect(Number(inv.vat_amount)).toBe(1.24);
    // BUG B3: total is accumulated from UNROUNDED per-line VAT → 15.07, but subtotal+vat = 15.06.
    // A correct invoice MUST satisfy total === subtotal + vat_amount.
    expect(Number(inv.total)).toBe(15.07);
    expect(Number(inv.total)).not.toBe(
      Math.round((Number(inv.subtotal) + Number(inv.vat_amount)) * 100) / 100,
    );
  });

  it('B4 (P1): a multi→single-rate edit leaves a STALE vat_breakdown on the row', async () => {
    // Pre-existing multi-rate breakdown, but the recalc result is single-rate (one 21% line).
    await seedInvoice(
      INV,
      [{ description: 'Sessie', quantity: 1, unit_price: 10, vat_rate: 21 }],
      21,
      { '9': { subtotal: 5, vat: 0.45 }, '21': { subtotal: 10, vat: 2.1 } },
    );

    await recalcCycleInvoiceTotals({ ...base, sessionPrice: 10, extraCosts: [] }, supa);

    const inv = await invoiceRow(INV);
    // BUG B4: single-rate result → vat_breakdown is only spread when non-empty, so the UPDATE omits
    // it and the stale multi-rate breakdown (incl. the bogus "9" bucket) survives.
    expect(inv.vat_breakdown).not.toBeNull();
    expect(Object.keys(inv.vat_breakdown ?? {})).toContain('9');
  });

  it('a paid invoice is excluded by the status filter and never recalculated', async () => {
    await db.query(
      `INSERT INTO invoices (id, status, booking_ids, line_items, vat_rate, subtotal, vat_amount, total, vat_breakdown, pdf_url)
       VALUES ($1,'paid',ARRAY['${B1}']::uuid[],$2::jsonb,21,99,99,99,NULL,'paid.pdf')`,
      [INV, JSON.stringify([{ description: 'Sessie', quantity: 1, unit_price: 99, vat_rate: 21 }])],
    );

    await recalcCycleInvoiceTotals({ ...base, sessionPrice: 10, extraCosts: [] }, supa);

    const inv = await invoiceRow(INV);
    expect(Number(inv.total)).toBe(99); // untouched — not in ('draft','sent','pending','overdue')
  });
});
