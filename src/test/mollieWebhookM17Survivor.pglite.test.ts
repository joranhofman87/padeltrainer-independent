// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// P1-4: applyBookingPaymentWriteback must tolerate the M-17 (slot, guest|player)
// partial-unique 23505 that fires when a paid payment_pending HOLD is flipped to
// 'confirmed' while a concurrent staff-add already created an active booking for
// the same person on the same slot. It resolves the SURVIVOR (the pre-existing
// active booking), stamps IT paid, cancels the redundant hold, and returns the
// survivor/paid id set so the caller keys side-effects correctly.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';
import { applyBookingPaymentWriteback } from '../../supabase/functions/_shared/mollie-webhook-payment.ts';

let db: PGlite;
let supa: ReturnType<typeof createPgliteSupabase>;

const PAID = { payment_status: 'paid', status: 'confirmed', mollie_transaction_id: 'tr_paid', paid_at: '2026-07-01T10:00:00.000Z', hold_expires_at: null };

const booking = async (id: string) =>
  (await db.query<{ payment_status: string; status: string; paid_at: string | null }>(
    `SELECT payment_status, status, paid_at FROM bookings WHERE id = $1`, [id],
  )).rows[0];

beforeAll(async () => {
  db = new PGlite();
  supa = createPgliteSupabase(db);
  await db.exec(`
    CREATE TABLE bookings (
      id text PRIMARY KEY, slot_id text, guest_player_id text, player_id text,
      payment_amount numeric, payment_status text NOT NULL DEFAULT 'pending',
      status text NOT NULL DEFAULT 'pending',
      paid_at timestamptz, mollie_transaction_id text, hold_expires_at timestamptz);
    -- The ACTUAL M-17 partial unique indexes (predicate excludes 'payment_pending').
    CREATE UNIQUE INDEX uniq_active_booking_per_slot_guest
      ON bookings (slot_id, guest_player_id)
      WHERE guest_player_id IS NOT NULL AND status IN ('pending','confirmed','completed');
    CREATE UNIQUE INDEX uniq_active_booking_per_slot_player
      ON bookings (slot_id, player_id)
      WHERE player_id IS NOT NULL AND guest_player_id IS NULL AND status IN ('pending','confirmed','completed');
  `);
});

beforeEach(async () => { await db.exec(`DELETE FROM bookings;`); });

describe('applyBookingPaymentWriteback M-17 survivor tolerance (P1-4)', () => {
  it('paid HOLD colliding with a pre-existing CONFIRMED booking → survivor stamped paid, hold cancelled, returns [survivor]', async () => {
    // SURVIVOR = staff-added confirmed booking; HOLD = the guest pay-first hold Mollie just paid.
    await db.exec(`INSERT INTO bookings (id, slot_id, guest_player_id, payment_status, status) VALUES
      ('SURV','S1','G1','pending','confirmed'),
      ('HOLD','S1','G1','pending','payment_pending');`);

    const transitioned = await applyBookingPaymentWriteback(supa, ['HOLD'], { ...PAID });

    // Side-effects must key to the SURVIVOR, not the (now cancelled) hold.
    expect(transitioned.map((r) => r.id)).toEqual(['SURV']);
    const surv = await booking('SURV');
    expect(surv.payment_status).toBe('paid');
    expect(surv.status).toBe('confirmed');
    expect(surv.paid_at).not.toBeNull();
    const hold = await booking('HOLD');
    expect(hold.status).toBe('cancelled'); // redundant hold cancelled
    expect(hold.payment_status).toBe('pending'); // never marked paid
  });

  it('IDEMPOTENT: survivor already paid → hold cancelled, ZERO ids returned (no side-effect re-run)', async () => {
    await db.exec(`INSERT INTO bookings (id, slot_id, guest_player_id, payment_status, status, paid_at) VALUES
      ('SURV','S1','G1','paid','confirmed','2026-06-30T09:00:00Z'),
      ('HOLD','S1','G1','pending','payment_pending', NULL);`);

    const transitioned = await applyBookingPaymentWriteback(supa, ['HOLD'], { ...PAID });

    expect(transitioned).toEqual([]); // survivor already paid → no new transition
    expect((await booking('SURV')).payment_status).toBe('paid');
    expect(new Date((await booking('SURV')).paid_at as string).toISOString()).toBe('2026-06-30T09:00:00.000Z');
    expect((await booking('HOLD')).status).toBe('cancelled');
  });

  it('BATCH subset-collision: non-colliding holds still confirm; only the colliding one uses the survivor path', async () => {
    // H_OK: a clean hold (no survivor) → flips normally to paid/confirmed.
    // H_DUP: collides with SURV on (S1,G2) → survivor stamped, hold cancelled.
    await db.exec(`INSERT INTO bookings (id, slot_id, guest_player_id, payment_status, status) VALUES
      ('H_OK','S1','G1','pending','payment_pending'),
      ('SURV','S1','G2','pending','confirmed'),
      ('H_DUP','S1','G2','pending','payment_pending');`);

    const transitioned = await applyBookingPaymentWriteback(supa, ['H_OK','H_DUP'], { ...PAID });

    // Final paid set = the clean hold (itself) + the survivor of the collision.
    expect(transitioned.map((r) => r.id).sort()).toEqual(['H_OK','SURV']);
    expect((await booking('H_OK')).payment_status).toBe('paid');
    expect((await booking('H_OK')).status).toBe('confirmed');
    expect((await booking('SURV')).payment_status).toBe('paid');
    expect((await booking('H_DUP')).status).toBe('cancelled');
  });

  it('player-keyed (registered) HOLD collision resolves the survivor by player_id', async () => {
    await db.exec(`INSERT INTO bookings (id, slot_id, player_id, payment_status, status) VALUES
      ('SURV','S1','P1','pending','confirmed'),
      ('HOLD','S1','P1','pending','payment_pending');`);

    const transitioned = await applyBookingPaymentWriteback(supa, ['HOLD'], { ...PAID });

    expect(transitioned.map((r) => r.id)).toEqual(['SURV']);
    expect((await booking('SURV')).payment_status).toBe('paid');
    expect((await booking('HOLD')).status).toBe('cancelled');
  });
});
