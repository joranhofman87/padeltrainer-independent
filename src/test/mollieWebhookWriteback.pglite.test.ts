// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';
import { applyBookingPaymentWriteback, findCancelledPaidBookings } from '../../supabase/functions/_shared/mollie-webhook-payment.ts';

// applyBookingPaymentWriteback takes the supabase client as a param, so we run the REAL helper
// against real Postgres (no JS mock) by handing it the PGlite-backed adapter directly — no
// supabaseClient module mock needed.
let db: PGlite;
let supa: ReturnType<typeof createPgliteSupabase>;

// The three updateData shapes the mollie-webhook handler builds, per its status mapping.
const PAID = { payment_status: 'paid', status: 'confirmed', mollie_transaction_id: 'tr_paid', paid_at: '2026-07-01T10:00:00.000Z' };
const PENDING = { payment_status: 'pending', status: 'pending', mollie_transaction_id: 'tr_pending' };
const FAILED = { payment_status: 'failed', status: 'cancelled', mollie_transaction_id: 'tr_failed' };

const booking = async (id: string) =>
  (await db.query<{ payment_status: string; status: string; paid_at: string | null; mollie_transaction_id: string | null }>(
    `SELECT payment_status, status, paid_at, mollie_transaction_id FROM bookings WHERE id = $1`,
    [id],
  )).rows[0];

beforeAll(async () => {
  db = new PGlite();
  supa = createPgliteSupabase(db);
  await db.exec(`
    CREATE TABLE bookings (
      id text PRIMARY KEY, slot_id text, payment_amount numeric,
      payment_status text NOT NULL DEFAULT 'pending', status text NOT NULL DEFAULT 'pending',
      paid_at timestamptz, mollie_transaction_id text);
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM bookings;`);
});

describe('applyBookingPaymentWriteback (against real Postgres)', () => {
  it('a paid webhook flips every still-unpaid booking and returns exactly those rows', async () => {
    await db.exec(`INSERT INTO bookings (id, slot_id, payment_status, status) VALUES
      ('B1','S1','pending','pending'), ('B2','S1','pending','pending');`);

    const transitioned = await applyBookingPaymentWriteback(supa, ['B1', 'B2'], { ...PAID });

    expect(transitioned.map((r) => r.id).sort()).toEqual(['B1', 'B2']);
    const b1 = await booking('B1');
    expect(b1.payment_status).toBe('paid');
    expect(b1.status).toBe('confirmed');
    expect(b1.paid_at).not.toBeNull();
    expect(b1.mollie_transaction_id).toBe('tr_paid');
  });

  it('IDEMPOTENT: a duplicate paid webhook transitions ZERO rows (side-effects must not re-run)', async () => {
    await db.exec(`INSERT INTO bookings (id, slot_id, payment_status, status, paid_at) VALUES
      ('B1','S1','paid','confirmed','2026-06-30T09:00:00Z'), ('B2','S1','paid','confirmed','2026-06-30T09:00:00Z');`);

    const transitioned = await applyBookingPaymentWriteback(supa, ['B1', 'B2'], { ...PAID });

    expect(transitioned).toEqual([]); // bookingsAlreadyPaid → shouldRunBookingPaidSideEffects=false
    // The original paid_at is preserved (the duplicate did not overwrite it).
    const b1 = await booking('B1');
    expect(b1.payment_status).toBe('paid');
    expect(new Date(b1.paid_at as string).toISOString()).toBe('2026-06-30T09:00:00.000Z');
  });

  it('GROUP: a single paid webhook flips ALL booking_ids in the group', async () => {
    await db.exec(`INSERT INTO bookings (id, slot_id, payment_status, status) VALUES
      ('B1','S1','pending','pending'), ('B2','S1','pending','pending'), ('B3','S2','pending','pending');`);

    const transitioned = await applyBookingPaymentWriteback(supa, ['B1', 'B2', 'B3'], { ...PAID });

    expect(transitioned.map((r) => r.id).sort()).toEqual(['B1', 'B2', 'B3']);
    for (const id of ['B1', 'B2', 'B3']) {
      expect((await booking(id)).payment_status).toBe('paid');
    }
  });

  it('REGRESSION (the bug): a stale open/pending webhook does NOT downgrade an already-paid booking', async () => {
    // B1 already paid (e.g. an earlier paid delivery, or a cash payment marked paid out-of-band),
    // B2 still pending. A late `open`/`pending` delivery for both must touch ONLY B2.
    await db.exec(`INSERT INTO bookings (id, slot_id, payment_status, status, paid_at, mollie_transaction_id) VALUES
      ('B1','S1','paid','confirmed','2026-06-30T09:00:00Z','tr_paid'),
      ('B2','S1','pending','pending', NULL, NULL);`);

    const transitioned = await applyBookingPaymentWriteback(supa, ['B1', 'B2'], { ...PENDING });

    expect(transitioned.map((r) => r.id)).toEqual(['B2']); // only the unpaid one moved
    const b1 = await booking('B1');
    expect(b1.payment_status).toBe('paid'); // NOT downgraded to pending
    expect(b1.status).toBe('confirmed'); // NOT un-confirmed
    expect(new Date(b1.paid_at as string).toISOString()).toBe('2026-06-30T09:00:00.000Z');
    expect(b1.mollie_transaction_id).toBe('tr_paid'); // untouched
    expect((await booking('B2')).payment_status).toBe('pending');
  });

  it('a stale failed/expired/cancelled webhook does NOT cancel an already-paid booking', async () => {
    await db.exec(`INSERT INTO bookings (id, slot_id, payment_status, status, paid_at) VALUES
      ('B1','S1','paid','confirmed','2026-06-30T09:00:00Z');`);

    const transitioned = await applyBookingPaymentWriteback(supa, ['B1'], { ...FAILED });

    expect(transitioned).toEqual([]);
    const b1 = await booking('B1');
    expect(b1.payment_status).toBe('paid'); // a paid booking is never cancelled by a stale fail
    expect(b1.status).toBe('confirmed');
  });

  it('a failed webhook still cancels an UNPAID booking (correct behaviour preserved)', async () => {
    await db.exec(`INSERT INTO bookings (id, slot_id, payment_status, status) VALUES
      ('B1','S1','pending','pending');`);

    const transitioned = await applyBookingPaymentWriteback(supa, ['B1'], { ...FAILED });

    expect(transitioned.map((r) => r.id)).toEqual(['B1']);
    const b1 = await booking('B1');
    expect(b1.payment_status).toBe('failed');
    expect(b1.status).toBe('cancelled');
  });

  it('REGRESSION (no-resurrection): a paid webhook does NOT un-cancel a CANCELLED booking', async () => {
    // The BookLesson online-cycle rollback soft-cancels its bookings (status='cancelled')
    // when payment creation fails, leaving payment_status='pending'. A late paid webhook for
    // a payment created just before that failure must NOT flip it back to paid/confirmed.
    await db.exec(`INSERT INTO bookings (id, slot_id, payment_status, status) VALUES
      ('B1','S1','pending','cancelled'), ('B2','S1','pending','pending');`);

    const transitioned = await applyBookingPaymentWriteback(supa, ['B1', 'B2'], { ...PAID });

    // Only the still-active B2 transitions; the cancelled B1 is left untouched.
    expect(transitioned.map((r) => r.id)).toEqual(['B2']);
    const b1 = await booking('B1');
    expect(b1.status).toBe('cancelled'); // NOT resurrected
    expect(b1.payment_status).toBe('pending'); // NOT marked paid
    expect(b1.paid_at).toBeNull();
    expect((await booking('B2')).payment_status).toBe('paid');
  });
});

describe('findCancelledPaidBookings (alert detector)', () => {
  it('flags a cancelled, not-yet-paid booking (paid payment landed on a cancelled seat → refund)', () => {
    const rows = [
      { id: 'A', status: 'cancelled', payment_status: 'pending' }, // money received, no seat → flag
      { id: 'B', status: 'confirmed', payment_status: 'pending' }, // active → not flagged
      { id: 'C', status: 'cancelled', payment_status: 'paid' }, // already settled → not flagged
    ];
    expect(findCancelledPaidBookings(rows)).toEqual(['A']);
  });

  it('returns empty when nothing is cancelled', () => {
    expect(findCancelledPaidBookings([{ id: 'A', status: 'confirmed', payment_status: 'pending' }])).toEqual([]);
  });
});

// The mollie-webhook INVOICE-paid branch syncs invoice.booking_ids: pre-read the linked bookings to
// flag a cancelled-but-unpaid seat for a refund, THEN route the write-back through the same guarded
// applyBookingPaymentWriteback the booking-pay branch uses. This composite is what makes the
// no-resurrection invariant hold for the invoice branch too — it previously did a RAW unguarded
// .update() over booking_ids, which could flip a since-cancelled booking back to paid/confirmed.
describe('invoice-paid branch: guarded linked-booking sync (composite contract)', () => {
  it('confirms active bookings, leaves a cancelled one untouched, flags it for refund', async () => {
    await db.exec(`INSERT INTO bookings (id, slot_id, payment_status, status) VALUES
      ('B1','S1','pending','cancelled'), ('B2','S1','pending','pending');`);
    const bookingIds = ['B1', 'B2']; // an invoice.booking_ids that includes a since-cancelled seat

    // 1. pre-read → refund detector flags the cancelled, not-yet-paid booking
    const { data: pre } = await supa.from('bookings').select('id, status, payment_status').in('id', bookingIds);
    expect(findCancelledPaidBookings(pre || [])).toEqual(['B1']);

    // 2. guarded write-back flips ONLY the still-active booking
    const transitioned = await applyBookingPaymentWriteback(supa, bookingIds, { ...PAID });
    expect(transitioned.map((r) => r.id)).toEqual(['B2']);

    // 3. the cancelled booking is NOT resurrected; the active one is paid+confirmed
    const b1 = await booking('B1');
    expect(b1.status).toBe('cancelled');
    expect(b1.payment_status).toBe('pending');
    expect(b1.paid_at).toBeNull();
    const b2 = await booking('B2');
    expect(b2.status).toBe('confirmed');
    expect(b2.payment_status).toBe('paid');
  });
});
