// @vitest-environment node
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';

const PAGE_CAP = 1000;

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: new Proxy(
    {},
    { get: (_t, prop: string) => (h.supa as Record<string, unknown>)?.[prop] },
  ),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: new Proxy(
    {},
    { get: (_t, prop: string) => (h.supa as Record<string, unknown>)?.[prop] },
  ),
}));

import { syncInvoicesAfterPriceChange } from '@/lib/invoiceSync';

let db: PGlite;
const N = 1500;

beforeAll(async () => {
  db = new PGlite();
  h.supa = createPgliteSupabase(db, { maxRows: PAGE_CAP });

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

    INSERT INTO cycles VALUES ('C1', '{}'::jsonb);
    INSERT INTO availability_slots (id, price_per_session, cyclus_id, cyclus_name, start_time, prices_include_vat, extra_costs, location_id)
      VALUES ('S1', 50, 'C1', 'Zomertraining', '2026-07-06 18:00:00+00', true, '[]'::jsonb, NULL);
  `);

  const bookingVals: string[] = [];
  const invoiceVals: string[] = [];
  for (let i = 0; i < N; i++) {
    const bid = `B${String(i).padStart(5, '0')}`;
    bookingVals.push(`('${bid}', 'S1', NULL, 'confirmed')`);
    invoiceVals.push(
      `('INV${String(i).padStart(5, '0')}', '2026-${i}', ARRAY['${bid}'], '[]'::jsonb, 0, 0, 999, 'draft', 21, 1)`,
    );
  }
  for (let i = 0; i < bookingVals.length; i += 500) {
    await db.exec(
      `INSERT INTO bookings (id, slot_id, payment_amount, status) VALUES ${bookingVals.slice(i, i + 500).join(',')};`,
    );
    await db.exec(
      `INSERT INTO invoices (id, invoice_number, booking_ids, line_items, subtotal, vat_amount, total, status, vat_rate, split_count) VALUES ${invoiceVals.slice(i, i + 500).join(',')};`,
    );
  }
});

describe('P1-7: cycle price re-sync spans >1000 invoices (real Postgres, cap enforced)', () => {
  it('rebuilds EVERY invoice past the 1000-row page cap (none left stale)', async () => {
    const before = (
      await db.query<{ c: string }>(`SELECT count(*) c FROM invoices WHERE total = 999`)
    ).rows[0];
    expect(Number(before.c)).toBe(N);
    expect(N).toBeGreaterThan(PAGE_CAP);

    await syncInvoicesAfterPriceChange(['S1']);

    const stale = (
      await db.query<{ c: string }>(`SELECT count(*) c FROM invoices WHERE total = 999`)
    ).rows[0];
    expect(Number(stale.c)).toBe(0);

    const rebuilt = (
      await db.query<{ c: string }>(`SELECT count(*) c FROM invoices WHERE total = 50`)
    ).rows[0];
    expect(Number(rebuilt.c)).toBe(N);
  });
});
