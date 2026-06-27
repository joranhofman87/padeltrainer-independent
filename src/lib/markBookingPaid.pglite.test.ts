// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';

// Route the real lib's `@/lib/supabaseClient` to a PGlite-backed adapter so the ACTUAL
// reconcile logic runs against real Postgres SQL (booking↔invoice reconcile-when-fully-covered).
const h = vi.hoisted(() => ({ supa: null as ReturnType<typeof createPgliteSupabase> | null }));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: new Proxy(
    {},
    { get: (_t, prop: string) => (h.supa as unknown as Record<string, unknown>)?.[prop] },
  ),
}));

import { setBookingPaymentAndReconcile, reconcileBookingInvoices } from '@/lib/bookings';

let db: PGlite;
const inv = async () =>
  (await db.query<{ status: string; paid_at: string | null }>(
    `SELECT status, paid_at FROM invoices WHERE id = 'INV1'`,
  )).rows[0];
const bk = async (id: string) =>
  (await db.query<{ payment_status: string; paid_at: string | null; paid_externally: boolean }>(
    `SELECT payment_status, paid_at, paid_externally FROM bookings WHERE id = $1`, [id],
  )).rows[0];

beforeAll(async () => {
  db = new PGlite();
  h.supa = createPgliteSupabase(db);
  await db.exec(`
    CREATE TABLE bookings (
      id text PRIMARY KEY, payment_status text NOT NULL DEFAULT 'pending',
      status text NOT NULL DEFAULT 'confirmed', paid_at timestamptz,
      paid_externally boolean NOT NULL DEFAULT false);
    CREATE TABLE invoices (
      id text PRIMARY KEY, status text NOT NULL, booking_ids text[] NOT NULL, paid_at timestamptz);
  `);
});

// Fresh: invoice INV1 over two pending bookings, status 'sent'.
beforeEach(async () => {
  await db.exec(`
    DELETE FROM bookings; DELETE FROM invoices;
    INSERT INTO bookings (id, payment_status, status) VALUES
      ('B1','pending','confirmed'), ('B2','pending','confirmed');
    INSERT INTO invoices (id, status, booking_ids) VALUES ('INV1','sent', ARRAY['B1','B2']);
  `);
});

describe('booking → invoice reconcile (reconcile-when-fully-covered, real Postgres)', () => {
  it('marks the booking paid_externally and sets paid_at', async () => {
    const res = await setBookingPaymentAndReconcile('B1', true);
    expect(res.bookingError).toBeNull();
    expect(res.invoiceSyncError).toBeNull();
    const b1 = await bk('B1');
    expect(b1.payment_status).toBe('paid');
    expect(b1.paid_externally).toBe(true);
    expect(b1.paid_at).not.toBeNull();
  });

  it('a PARTIALLY paid invoice stays open; only flips to paid once ALL bookings are paid', async () => {
    await setBookingPaymentAndReconcile('B1', true);
    expect((await inv()).status).toBe('sent'); // B2 still pending → not fully covered

    await setBookingPaymentAndReconcile('B2', true);
    const i = await inv();
    expect(i.status).toBe('paid'); // now fully covered
    expect(i.paid_at).not.toBeNull();
  });

  it('un-marking a booking reverts a PAID invoice back to sent (coverage broken)', async () => {
    await setBookingPaymentAndReconcile('B1', true);
    await setBookingPaymentAndReconcile('B2', true);
    expect((await inv()).status).toBe('paid');

    const res = await setBookingPaymentAndReconcile('B1', false);
    expect(res.invoiceSyncError).toBeNull();
    const i = await inv();
    expect(i.status).toBe('sent'); // reverted
    expect(i.paid_at).toBeNull();
    const b1 = await bk('B1');
    expect(b1.payment_status).toBe('pending');
    expect(b1.paid_externally).toBe(false);
  });

  it('a cancelled booking on the invoice does NOT block full coverage', async () => {
    await db.exec(`UPDATE bookings SET status = 'cancelled' WHERE id = 'B2';`);
    await setBookingPaymentAndReconcile('B1', true);
    // active = {B1}, all paid → invoice paid despite B2 cancelled
    expect((await inv()).status).toBe('paid');
  });

  it('a cancelled invoice is never revived to paid', async () => {
    await db.exec(`
      UPDATE invoices SET status = 'cancelled' WHERE id = 'INV1';
      UPDATE bookings SET payment_status = 'paid';
    `);
    await reconcileBookingInvoices(['B1', 'B2']);
    expect((await inv()).status).toBe('cancelled');
  });

  it('reconcile is idempotent — re-running on an already-correct state is a no-op', async () => {
    await setBookingPaymentAndReconcile('B1', true);
    await setBookingPaymentAndReconcile('B2', true);
    expect((await inv()).status).toBe('paid');
    await reconcileBookingInvoices(['B1']); // again
    await reconcileBookingInvoices(['B2']); // again
    expect((await inv()).status).toBe('paid'); // unchanged, no throw
  });

  it('empty input is a no-op', async () => {
    await expect(reconcileBookingInvoices([])).resolves.toBeUndefined();
  });
});
