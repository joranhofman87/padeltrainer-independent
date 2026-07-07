// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// RB-P1-01 — create-mollie-payment must refuse to mint a second Mollie payment for bookings
// already covered by an ACTIVE (payable, unpaid) invoice, or the player is double-CHARGED
// (the webhook stops a double-booking, but both payments capture money). This pins the
// predicate the edge-fn guard relies on: "any invoice overlapping these booking_ids whose
// status is not paid/cancelled/draft" — draft has no pay-link so it can't be paid concurrently.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

const B1 = '10000000-0000-0000-0000-000000000001'; // on a 'sent' (active) invoice
const B2 = '10000000-0000-0000-0000-000000000002'; // on a 'paid' invoice
const B3 = '10000000-0000-0000-0000-000000000003'; // on a 'cancelled' invoice
const B4 = '10000000-0000-0000-0000-000000000004'; // on a 'draft' invoice
const B5 = '10000000-0000-0000-0000-000000000005'; // on NO invoice

// Mirrors the edge-fn guard: overlap on booking_ids, exclude paid/cancelled/draft.
const hasActiveInvoice = async (bookingIds: string[]): Promise<boolean> =>
  (
    await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.invoices
        WHERE booking_ids && $1::uuid[]
          AND status NOT IN ('paid','cancelled','draft')`,
      [bookingIds],
    )
  ).rows[0].n > 0;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_ids uuid[] DEFAULT '{}', status text);
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM public.invoices;`);
  await db.query(
    `INSERT INTO public.invoices (booking_ids, status) VALUES
      (ARRAY[$1]::uuid[], 'sent'),
      (ARRAY[$2]::uuid[], 'paid'),
      (ARRAY[$3]::uuid[], 'cancelled'),
      (ARRAY[$4]::uuid[], 'draft')`,
    [B1, B2, B3, B4],
  );
});

describe('active-invoice overlap guard (RB-P1-01 predicate)', () => {
  it('a booking on a SENT (payable) invoice is blocked', async () => {
    expect(await hasActiveInvoice([B1])).toBe(true);
  });

  it('a booking only on a PAID invoice is not blocked (already settled; payment_status check owns it)', async () => {
    expect(await hasActiveInvoice([B2])).toBe(false);
  });

  it('a booking only on a CANCELLED invoice is not blocked', async () => {
    expect(await hasActiveInvoice([B3])).toBe(false);
  });

  it('a booking only on a DRAFT invoice is not blocked (drafts have no pay-link)', async () => {
    expect(await hasActiveInvoice([B4])).toBe(false);
  });

  it('a booking on NO invoice is not blocked', async () => {
    expect(await hasActiveInvoice([B5])).toBe(false);
  });

  it('overlap: any one booking on an active invoice blocks the whole request', async () => {
    expect(await hasActiveInvoice([B5, B2, B1])).toBe(true); // B1 is on the sent invoice
  });

  it('a multi-booking invoice matches any of its bookings', async () => {
    await db.query(`INSERT INTO public.invoices (booking_ids, status) VALUES (ARRAY[$1,$2]::uuid[], 'pending')`, [B5, B4]);
    expect(await hasActiveInvoice([B5])).toBe(true); // B5 now on a pending multi-booking invoice
  });
});
