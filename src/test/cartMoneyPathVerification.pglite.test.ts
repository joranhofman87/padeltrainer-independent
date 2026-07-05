// @vitest-environment node
// Cart money-path verification (cart PR 5) — the audit's blocking webhook-side tests
// (docs/audits/MULTI_SESSION_CART_BOOKING_AUDIT.md §16): the REAL cart RPC's holds driven
// through the REAL webhook write-back helper against real Postgres.
//
//   - flagship: 3 selected slots, one paid webhook → 3 confirmed+paid bookings
//   - duplicate webhook → 0 transitions → paid side effects skipped
//   - amount-sum tolerance max(0.01, n*0.01) over N bookings
//   - G8: hold expired+swept before the paid webhook → no resurrection, alert path
//   - late non-paid delivery cannot downgrade a paid cart
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';
import {
  applyBookingPaymentWriteback,
  bookingSumMatches,
  bookingSumTolerance,
  findCancelledPaidBookings,
  shouldRunBookingPaidSideEffects,
} from '../../supabase/functions/_shared/mollie-webhook-payment.ts';

let db: PGlite;
let supa: ReturnType<typeof createPgliteSupabase>;

const S1 = '10000000-0000-0000-0000-000000000001';
const S2 = '10000000-0000-0000-0000-000000000002';
const S3 = '10000000-0000-0000-0000-000000000003';
const G1 = '20000000-0000-0000-0000-000000000001';

// The webhook's paid/failed update shapes (mollie-webhook status mapping).
const PAID = { payment_status: 'paid', status: 'confirmed', mollie_transaction_id: 'tr_paid', paid_at: '2026-07-05T10:00:00.000Z', hold_expires_at: null };
const FAILED = { payment_status: 'failed', status: 'cancelled', mollie_transaction_id: 'tr_failed' };

function readCartMigration(): string {
  return readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260707100000_book_guest_cart_for_payment.sql'),
    'utf8',
  )
    .split('\n')
    .filter((l) => !/^(REVOKE|GRANT)\b/.test(l))
    .join('\n');
}

const bookCart = async (guest: string, slots: string[], amounts: number[]): Promise<string[]> => {
  const res = await db.query<{ book_guest_cart_for_payment: string[] }>(
    `SELECT public.book_guest_cart_for_payment($1::uuid, $2::uuid[], $3::numeric[], 20, NULL)`,
    [guest, slots, amounts],
  );
  return res.rows[0].book_guest_cart_for_payment;
};

const bookingRows = async (ids: string[]) =>
  (
    await db.query<{ id: string; status: string; payment_status: string; payment_amount: string; paid_at: string | null; hold_expires_at: string | null }>(
      `SELECT id, status, payment_status, payment_amount, paid_at, hold_expires_at FROM bookings WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [ids],
    )
  ).rows;

beforeAll(async () => {
  db = new PGlite();
  supa = createPgliteSupabase(db);
  await db.exec(`
    CREATE TABLE availability_slots (
      id uuid PRIMARY KEY, max_participants integer,
      allow_single_booking boolean, is_public boolean, cyclus_id uuid, split_payment boolean
    );
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, player_id uuid, guest_player_id uuid,
      status text, payment_status text, payment_amount numeric,
      hold_expires_at timestamptz, notes text, paid_at timestamptz, mollie_transaction_id text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
  `);
  await db.exec(readCartMigration());
});

beforeEach(async () => {
  await db.exec(`
    DELETE FROM bookings; DELETE FROM availability_slots;
    INSERT INTO availability_slots (id, max_participants, allow_single_booking, is_public, cyclus_id, split_payment) VALUES
      ('${S1}', 2, true, true, NULL, false),
      ('${S2}', 2, true, true, NULL, false),
      ('${S3}', 1, true, true, NULL, false);
  `);
});

describe('flagship: select 3 slots, pay once', () => {
  it('one paid webhook confirms all 3 holds with the charged amounts', async () => {
    const ids = await bookCart(G1, [S1, S2, S3], [15, 12.5, 20]);

    const transitioned = await applyBookingPaymentWriteback(supa, ids, PAID);
    expect(transitioned).toHaveLength(3);
    expect(shouldRunBookingPaidSideEffects('paid', transitioned.length === 0)).toBe(true);

    const rows = await bookingRows(ids);
    for (const r of rows) {
      expect(r.status).toBe('confirmed');
      expect(r.payment_status).toBe('paid');
      expect(r.paid_at).not.toBeNull();
      expect(r.hold_expires_at).toBeNull();
    }
    // the webhook's amount guard: stored sum == the Mollie charge
    const sum = rows.reduce((s, r) => s + Number(r.payment_amount), 0);
    expect(sum).toBe(47.5);
    expect(bookingSumMatches(sum, 47.5, ids.length)).toBe(true);
  });

  it('a duplicate delivery transitions 0 rows → paid side effects are skipped', async () => {
    const ids = await bookCart(G1, [S1, S2], [15, 12.5]);
    await applyBookingPaymentWriteback(supa, ids, PAID);

    const second = await applyBookingPaymentWriteback(supa, ids, PAID);
    expect(second).toHaveLength(0);
    // the caller's gate: bookingsAlreadyPaid=true → no second invoice/email
    expect(shouldRunBookingPaidSideEffects('paid', second.length === 0)).toBe(false);
  });
});

describe('amount-sum guard over N bookings', () => {
  it('tolerance is max(0.01, n*0.01)', () => {
    expect(bookingSumTolerance(1)).toBe(0.01);
    expect(bookingSumTolerance(3)).toBeCloseTo(0.03, 10);
    expect(bookingSumTolerance(20)).toBeCloseTo(0.2, 10);
  });

  it('accepts rounding drift within tolerance, blocks anything past it', () => {
    // 3 bookings (tolerance 0.03): a 2-cent drift passes, a 5-cent drift blocks the
    // commit. (The exact 3-cent boundary is FP-fuzzy — deliberately not asserted.)
    expect(bookingSumMatches(47.5, 47.52, 3)).toBe(true);
    expect(bookingSumMatches(47.5, 47.55, 3)).toBe(false);
    // 1 booking stays at the strict ±0.01
    expect(bookingSumMatches(20, 20.02, 1)).toBe(false);
  });
});

describe('G8: hold expired + swept before the paid webhook lands', () => {
  it('no resurrection — 0 transitions, and the alert path names every cancelled id', async () => {
    const ids = await bookCart(G1, [S1, S2], [15, 12.5]);
    // the TTL sweep (release_expired_guest_slot_holds semantics): expired unpaid holds → cancelled
    await db.query(
      `UPDATE bookings SET status = 'cancelled'
       WHERE id = ANY($1::uuid[]) AND status = 'payment_pending' AND payment_status = 'pending'`,
      [ids],
    );

    const transitioned = await applyBookingPaymentWriteback(supa, ids, PAID);
    expect(transitioned).toHaveLength(0);

    const rows = await bookingRows(ids);
    for (const r of rows) {
      expect(r.status).toBe('cancelled'); // never resurrected
      expect(r.payment_status).toBe('pending'); // never stamped paid
    }
    // the caller distinguishes "already paid" from "money on a cancelled cart" via:
    expect(findCancelledPaidBookings(rows).sort()).toEqual([...ids].sort());
  });

  it('capacity self-heals: the swept seat is immediately bookable by the next guest', async () => {
    const [hold] = await bookCart(G1, [S3], [20]); // S3 capacity 1
    await db.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1::uuid`, [hold]);
    const ids = await bookCart('20000000-0000-0000-0000-000000000002', [S3], [20]);
    expect(ids).toHaveLength(1);
  });
});

describe('ordering safety', () => {
  it('a late FAILED delivery cannot downgrade a paid cart', async () => {
    const ids = await bookCart(G1, [S1, S2], [15, 12.5]);
    await applyBookingPaymentWriteback(supa, ids, PAID);

    const downgraded = await applyBookingPaymentWriteback(supa, ids, FAILED);
    expect(downgraded).toHaveLength(0);

    const rows = await bookingRows(ids);
    for (const r of rows) {
      expect(r.payment_status).toBe('paid');
      expect(r.status).toBe('confirmed');
    }
  });
});
