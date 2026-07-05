// @vitest-environment node
// whole_slot_booking (migration 20260707140000): a cyclus session with the flag sells
// individually as the WHOLE slot at FULL price — one booking, capacity 1. The flag PERMITS,
// it never reprices: both RPCs' capacity CASEs are untouched; only the
// single_booking_not_allowed guard is loosened, and NEVER for split sessions (that would
// recreate the #352 over-collection).
//
// Runs the REAL deployed SQL: base cart migration + the whole_slot successor.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const CYCLUS = '30000000-0000-0000-0000-000000000001';
const WHOLE = '10000000-0000-0000-0000-000000000001'; // cyclus session, whole_slot_booking=true
const WHOLE2 = '10000000-0000-0000-0000-000000000002'; // sibling whole-slot session
const LOCKED = '10000000-0000-0000-0000-000000000003'; // cyclus session, no flags
const SPLITWS = '10000000-0000-0000-0000-000000000004'; // split + whole_slot (invalid combo)
const G1 = '20000000-0000-0000-0000-000000000001';
const G2 = '20000000-0000-0000-0000-000000000002';

function readMigrations(): string {
  return ['20260707100000_book_guest_cart_for_payment.sql', '20260707140000_whole_slot_booking.sql']
    .map((f) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8'))
    .join('\n')
    .split('\n')
    .filter((l) => !/^(REVOKE|GRANT)\b/.test(l))
    .join('\n');
}

const bookSlot = async (slot: string, guest: string, amount: number): Promise<string> =>
  (
    await db.query<{ book_guest_slot_for_payment: string }>(
      `SELECT public.book_guest_slot_for_payment($1::uuid, $2::uuid, $3::numeric, 20, NULL)`,
      [slot, guest, amount],
    )
  ).rows[0].book_guest_slot_for_payment;

const bookCart = async (guest: string, slots: string[], amounts: number[]): Promise<string[]> =>
  (
    await db.query<{ book_guest_cart_for_payment: string[] }>(
      `SELECT public.book_guest_cart_for_payment($1::uuid, $2::uuid[], $3::numeric[], 20, NULL)`,
      [guest, slots, amounts],
    )
  ).rows[0].book_guest_cart_for_payment;

const expectRefusal = async (p: Promise<unknown>, code: string) => {
  let err: unknown;
  await p.then(
    () => {
      throw new Error(`expected ${code}, but the call succeeded`);
    },
    (e) => {
      err = e;
    },
  );
  expect((err as { message?: string }).message).toContain(code);
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE availability_slots (
      id uuid PRIMARY KEY,
      max_participants integer,
      allow_single_booking boolean,
      is_public boolean,
      cyclus_id uuid,
      split_payment boolean
    );
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid,
      player_id uuid,
      guest_player_id uuid,
      status text,
      payment_status text,
      payment_amount numeric,
      hold_expires_at timestamptz,
      notes text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
  `);
  await db.exec(readMigrations()); // the successor migration ALTERs whole_slot_booking onto the table
});

beforeEach(async () => {
  await db.exec(`
    DELETE FROM bookings; DELETE FROM availability_slots;
    INSERT INTO availability_slots (id, max_participants, allow_single_booking, is_public, cyclus_id, split_payment, whole_slot_booking) VALUES
      ('${WHOLE}',   4, false, true, '${CYCLUS}', false, true),
      ('${WHOLE2}',  4, false, true, '${CYCLUS}', false, true),
      ('${LOCKED}',  4, false, true, '${CYCLUS}', false, false),
      ('${SPLITWS}', 4, false, true, '${CYCLUS}', true,  true);
  `);
});

describe('single-slot RPC — whole-slot cyclus sessions', () => {
  it('books the session as ONE whole-slot hold at the full amount (max_participants stays 4 for staff)', async () => {
    const id = await bookSlot(WHOLE, G1, 76.5);
    const row = (
      await db.query<{ status: string; payment_amount: string }>(
        `SELECT status, payment_amount FROM bookings WHERE id = $1`,
        [id],
      )
    ).rows[0];
    expect(row.status).toBe('payment_pending');
    expect(Number(row.payment_amount)).toBe(76.5);
    // capacity 1: the whole court is claimed — a second guest is refused
    await expectRefusal(bookSlot(WHOLE, G2, 76.5), 'slot_full');
  });

  it('still refuses a cyclus session WITHOUT the flag (guard regression)', async () => {
    await expectRefusal(bookSlot(LOCKED, G1, 76.5), 'single_booking_not_allowed');
  });

  it('NEVER unlocks a split session (the #352 over-collection stays closed)', async () => {
    await expectRefusal(bookSlot(SPLITWS, G1, 76.5), 'single_booking_not_allowed');
  });
});

describe('cart RPC — whole-slot cyclus sessions', () => {
  it('carts two whole-slot sessions atomically at full per-item amounts', async () => {
    const ids = await bookCart(G1, [WHOLE, WHOLE2], [76.5, 76.5]);
    expect(ids).toHaveLength(2);
    const sum = (
      await db.query<{ s: string }>(`SELECT sum(payment_amount)::text AS s FROM bookings WHERE guest_player_id = $1`, [G1])
    ).rows[0].s;
    expect(Number(sum)).toBe(153);
    // each session is fully claimed
    await expectRefusal(bookCart(G2, [WHOLE], [76.5]), 'slot_full');
  });

  it('still refuses flag-less cyclus sessions and split sessions in a cart', async () => {
    await expectRefusal(bookCart(G1, [WHOLE, LOCKED], [76.5, 76.5]), 'single_booking_not_allowed');
    await expectRefusal(bookCart(G1, [SPLITWS], [76.5]), 'split_not_supported');
    // all-or-nothing held: no partial holds from the refusals above
    const n = (
      await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE guest_player_id = $1`, [G1])
    ).rows[0].n;
    expect(n).toBe(0);
  });
});
