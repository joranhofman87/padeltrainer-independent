// @vitest-environment node
// book_guest_cart_for_payment — the multi-session cart's only mutation boundary
// (migration 20260707100000, design docs/audits/MULTI_SESSION_CART_BOOKING_AUDIT.md §6.1).
//
// The function body is loaded verbatim from the migration file so the test exercises the exact
// SQL that deploys (GRANT/REVOKE stripped — those roles don't exist in PGlite).
//
// NOTE on concurrency: PGlite is single-connection, so the "two carts race for the last seat"
// case is tested in its sequential-equivalent form (a live payment_pending hold from guest A
// occupies the seat when guest B's transaction runs). A true parallel double-mint test remains
// the known invariant-#1 gap (docs/payments/PAYMENT_TEST_GAPS.md).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

// Slot fixtures (see beforeEach): three cartable per-seat slots, a whole-court standalone,
// a private slot, a split session, and a cyclus session without allow_single_booking.
const S1 = '10000000-0000-0000-0000-000000000001'; // per-seat, cap 2
const S2 = '10000000-0000-0000-0000-000000000002'; // per-seat, cap 2
const S3 = '10000000-0000-0000-0000-000000000003'; // per-seat, cap 1
const WHOLE = '10000000-0000-0000-0000-000000000004'; // allow_single=false, standalone → whole-slot, cap 1
const HIDDEN = '10000000-0000-0000-0000-000000000005'; // is_public=false
const SPLIT = '10000000-0000-0000-0000-000000000006'; // split_payment=true
const CYCSESS = '10000000-0000-0000-0000-000000000007'; // cyclus session, allow_single=false
const MISSING = '10000000-0000-0000-0000-00000000dead'; // no row

const G1 = '20000000-0000-0000-0000-000000000001';
const G2 = '20000000-0000-0000-0000-000000000002';

const CYCLUS = '30000000-0000-0000-0000-000000000001';

function readCartMigration(): string {
  const sql = readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260707100000_book_guest_cart_for_payment.sql'),
    'utf8',
  );
  // service_role doesn't exist in PGlite — strip the grant block, keep the function byte-identical.
  return sql
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

const count = async (where: string): Promise<number> =>
  Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE ${where}`)).rows[0].n);

/** Assert the RPC refuses with `code` and (when given) names the offending slot in DETAIL. */
const expectRefusal = async (p: Promise<unknown>, code: string, slotId?: string) => {
  let err: unknown;
  await p.then(
    () => {
      throw new Error(`expected ${code}, but the call succeeded`);
    },
    (e) => {
      err = e;
    },
  );
  const e = err as { message?: string; detail?: string };
  expect(e.message).toContain(code);
  if (slotId) {
    const detail = e.detail ?? e.message ?? '';
    expect(detail).toContain(slotId);
  }
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
  await db.exec(readCartMigration());
});

beforeEach(async () => {
  await db.exec(`
    DELETE FROM bookings; DELETE FROM availability_slots;
    INSERT INTO availability_slots (id, max_participants, allow_single_booking, is_public, cyclus_id, split_payment) VALUES
      ('${S1}', 2, true,  true,  NULL,        false),
      ('${S2}', 2, true,  true,  NULL,        false),
      ('${S3}', 1, true,  true,  NULL,        false),
      ('${WHOLE}', 4, false, true,  NULL,      false),
      ('${HIDDEN}', 2, true,  false, NULL,     false),
      ('${SPLIT}', 2, false, true,  '${CYCLUS}', true),
      ('${CYCSESS}', 2, false, true,  '${CYCLUS}', false);
  `);
});

describe('book_guest_cart_for_payment — happy path', () => {
  it('holds every selected session atomically with per-item amounts (input order)', async () => {
    const ids = await bookCart(G1, [S1, S2, S3], [15, 12.5, 20]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);

    const rows = await db.query<{ slot_id: string; status: string; payment_status: string; payment_amount: string; hold_expires_at: string | null }>(
      `SELECT slot_id, status, payment_status, payment_amount, hold_expires_at FROM bookings WHERE guest_player_id = $1 ORDER BY slot_id`,
      [G1],
    );
    expect(rows.rows).toHaveLength(3);
    for (const r of rows.rows) {
      expect(r.status).toBe('payment_pending');
      expect(r.payment_status).toBe('pending');
      expect(r.hold_expires_at).not.toBeNull();
    }
    const bySlot = Object.fromEntries(rows.rows.map((r) => [r.slot_id, Number(r.payment_amount)]));
    expect(bySlot[S1]).toBe(15);
    expect(bySlot[S2]).toBe(12.5);
    expect(bySlot[S3]).toBe(20);
  });

  it('books a standalone whole-court slot (allow_single_booking=false, no cyclus) as one whole-slot item', async () => {
    const ids = await bookCart(G1, [WHOLE], [40]);
    expect(ids).toHaveLength(1);
    // Whole-slot capacity is 1 regardless of max_participants=4: a second guest is refused.
    await expectRefusal(bookCart(G2, [WHOLE], [40]), 'slot_full', WHOLE);
  });

  it('is idempotent: a re-click returns the SAME hold set, no duplicates', async () => {
    const a = await bookCart(G1, [S1, S2], [15, 12.5]);
    const b = await bookCart(G1, [S1, S2], [15, 12.5]);
    expect(new Set(b)).toEqual(new Set(a));
    expect(await count(`guest_player_id = '${G1}'`)).toBe(2);
  });

  it('reuses a live partial hold instead of stacking a second one on the same slot', async () => {
    const [holdS1] = await bookCart(G1, [S1], [15]);
    const ids = await bookCart(G1, [S1, S2], [15, 12.5]);
    expect(ids).toContain(holdS1);
    expect(await count(`guest_player_id = '${G1}' AND slot_id = '${S1}'`)).toBe(1);
    expect(await count(`guest_player_id = '${G1}'`)).toBe(2);
  });
});

describe('book_guest_cart_for_payment — all-or-nothing', () => {
  // The offending slot's position must not matter: locks are taken in sorted order but the
  // failure must always roll back the WHOLE transaction (G9 pattern).
  it.each([
    ['first', S1],
    ['middle', S2],
    ['last', S3],
  ])('rolls back every hold when the %s selected slot is full', async (_pos, fullSlot) => {
    // Occupy the target slot completely (cap 2 for S1/S2, cap 1 for S3).
    await db.query(
      `INSERT INTO bookings (slot_id, guest_player_id, status, payment_status)
       SELECT $1::uuid, '${G2}'::uuid, 'confirmed', 'paid' FROM generate_series(1, 2)`,
      [fullSlot],
    );
    await expectRefusal(bookCart(G1, [S1, S2, S3], [15, 12.5, 20]), 'slot_full', fullSlot);
    expect(await count(`guest_player_id = '${G1}'`)).toBe(0);
  });

  it('sequential-equivalent race: guest A’s live hold on the last seat refuses guest B’s whole cart', async () => {
    await bookCart(G2, [S3], [20]); // S3 capacity 1 — A's payment_pending hold occupies it
    await expectRefusal(bookCart(G1, [S1, S3], [15, 20]), 'slot_full', S3);
    expect(await count(`guest_player_id = '${G1}'`)).toBe(0);
  });

  it('an EXPIRED hold does not occupy capacity (self-healing)', async () => {
    await db.query(
      `INSERT INTO bookings (slot_id, guest_player_id, status, payment_status, hold_expires_at)
       VALUES ('${S3}', '${G2}', 'payment_pending', 'pending', now() - interval '1 minute')`,
    );
    const ids = await bookCart(G1, [S3], [20]);
    expect(ids).toHaveLength(1);
  });
});

describe('book_guest_cart_for_payment — per-item guards (belt-and-suspenders vs the edge fn)', () => {
  it('refuses a private slot with slot_not_public + the offending id', async () => {
    await expectRefusal(bookCart(G1, [S1, HIDDEN], [15, 15]), 'slot_not_public', HIDDEN);
    expect(await count(`guest_player_id = '${G1}'`)).toBe(0);
  });

  it('refuses a split-payment session with split_not_supported (cart v1 excludes split)', async () => {
    await expectRefusal(bookCart(G1, [SPLIT], [50]), 'split_not_supported', SPLIT);
  });

  it('refuses a cyclus session without allow_single_booking (must go whole-cyclus)', async () => {
    await expectRefusal(bookCart(G1, [S1, CYCSESS], [15, 25]), 'single_booking_not_allowed', CYCSESS);
    expect(await count(`guest_player_id = '${G1}'`)).toBe(0);
  });

  it('refuses an unknown slot id with slot_unavailable (no silent fallthrough)', async () => {
    await expectRefusal(bookCart(G1, [S1, MISSING], [15, 15]), 'slot_unavailable', MISSING);
    expect(await count(`guest_player_id = '${G1}'`)).toBe(0);
  });
});

describe('book_guest_cart_for_payment — input validation', () => {
  it('refuses duplicate slot ids (would desync the amounts distribution)', async () => {
    await expectRefusal(bookCart(G1, [S1, S1], [15, 15]), 'invalid_input');
  });

  it('refuses an amounts/slots length mismatch', async () => {
    await expectRefusal(bookCart(G1, [S1, S2], [15]), 'invalid_input');
  });

  it('refuses an empty cart', async () => {
    await expectRefusal(bookCart(G1, [], []), 'invalid_input');
  });
});
