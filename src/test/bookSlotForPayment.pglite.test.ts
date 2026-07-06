// @vitest-environment node
// book_slot_for_payment — the AUTHED single-slot purchase RPC (create-mollie-payment
// owns the booking insert for online single-slot bookings; Option A mutation
// boundary). This was the only purchase RPC without a behavioral suite — the guest
// RPCs (slot/cyclus/cart) all had one. Runs the REAL migration SQL (20260701130000,
// the current 4-arg definition).
//
// Deliberate semantics pinned here (facts, not aspirations):
//  - capacity counts every non-cancelled booking (other players' pendings included),
//    serialized by a per-slot advisory lock;
//  - NO idempotency at this layer: a retry inserts a second pending booking —
//    create-mollie-payment's repay-decision (reuse/cancel/recreate) owns retries;
//  - NO visibility/allow_single guards here — the edge fn pre-checks those.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const SLOT = '10000000-0000-0000-0000-000000000001';
const SLOT_NOCAP = '10000000-0000-0000-0000-000000000002';
const P1 = '20000000-0000-0000-0000-000000000001';
const P2 = '20000000-0000-0000-0000-000000000002';
const P3 = '20000000-0000-0000-0000-000000000003';

const readMigration = () =>
  readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260701130000_book_slot_for_payment_notes.sql'), 'utf8')
    .split('\n')
    .filter((l) => !/^(REVOKE|GRANT)\b/.test(l))
    .join('\n');

const book = async (slot: string, player: string, amount: number, notes?: string | null) =>
  (
    await db.query<{ book_slot_for_payment: string }>(
      notes === undefined
        ? `SELECT public.book_slot_for_payment($1::uuid, $2::uuid, $3::numeric)`
        : `SELECT public.book_slot_for_payment($1::uuid, $2::uuid, $3::numeric, $4)`,
      notes === undefined ? [slot, player, amount] : [slot, player, amount, notes],
    )
  ).rows[0].book_slot_for_payment;

const expectSlotFull = async (p: Promise<unknown>) => {
  let msg = '';
  await p.then(
    () => {
      throw new Error('expected slot_full, but the booking succeeded');
    },
    (e: { message?: string }) => {
      msg = String(e.message ?? e);
    },
  );
  expect(msg).toContain('slot_full');
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE availability_slots (id uuid PRIMARY KEY, max_participants integer);
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid NOT NULL,
      player_id uuid,
      payment_status text,
      status text,
      payment_amount numeric,
      notes text,
      created_at timestamptz DEFAULT now()
    );
  `);
  await db.exec(readMigration());
});

beforeEach(async () => {
  await db.exec(`DELETE FROM bookings; DELETE FROM availability_slots;`);
  await db.query(`INSERT INTO availability_slots (id, max_participants) VALUES ($1, 2), ($2, NULL)`, [SLOT, SLOT_NOCAP]);
});

describe('book_slot_for_payment (real migration SQL)', () => {
  it('creates a pending booking carrying the server-computed amount and trimmed notes', async () => {
    const id = await book(SLOT, P1, 25.5, '  baan 3 graag  ');
    const { rows } = await db.query<{ payment_status: string; status: string; payment_amount: string; notes: string }>(
      `SELECT payment_status, status, payment_amount, notes FROM bookings WHERE id = $1`,
      [id],
    );
    expect(rows[0].payment_status).toBe('pending');
    expect(rows[0].status).toBe('pending');
    expect(Number(rows[0].payment_amount)).toBe(25.5);
    expect(rows[0].notes).toBe('baan 3 graag');
  });

  it('whitespace-only and 3-arg (default) notes are stored as NULL', async () => {
    const a = await book(SLOT, P1, 10, '   ');
    const b = await book(SLOT, P2, 10); // 3-arg call resolves via the DEFAULT
    const { rows } = await db.query<{ id: string; notes: string | null }>(
      `SELECT id, notes FROM bookings WHERE id IN ($1, $2)`,
      [a, b],
    );
    expect(rows.every((r) => r.notes === null)).toBe(true);
  });

  it("slot_full once non-cancelled bookings reach capacity — other players' pendings count", async () => {
    await book(SLOT, P1, 10);
    await book(SLOT, P2, 10);
    await expectSlotFull(book(SLOT, P3, 10));
  });

  it('cancelled bookings free their seat', async () => {
    await book(SLOT, P1, 10);
    const second = await book(SLOT, P2, 10);
    await db.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [second]);
    // seat freed → a third player books fine
    await book(SLOT, P3, 10);
    await expectSlotFull(book(SLOT, P1, 10));
  });

  it('NULL max_participants falls back to capacity 1', async () => {
    await book(SLOT_NOCAP, P1, 10);
    await expectSlotFull(book(SLOT_NOCAP, P2, 10));
  });

  it('no idempotency at this layer: a retry inserts a second pending (repay-decision owns retries)', async () => {
    const first = await book(SLOT, P1, 10);
    const second = await book(SLOT, P1, 10);
    expect(second).not.toBe(first);
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bookings WHERE slot_id = $1 AND player_id = $2`,
      [SLOT, P1],
    );
    expect(rows[0].n).toBe(2);
  });
});
