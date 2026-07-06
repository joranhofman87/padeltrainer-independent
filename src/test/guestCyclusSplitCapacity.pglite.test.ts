// @vitest-environment node
// Public-booking audit P1-2: book_guest_cyclus_for_payment must treat a split_payment session as
// PER-SEAT (capacity max_participants) so N guests can each book the whole series and each pay
// total ÷ N. Before 20260706160000 the capacity keyed off allow_single_booking only, so a
// split_payment + allow_single_booking=false cyclus capped at 1 — only the first guest could book.
//
// Runs the REAL deployed SQL: migration 20260706160000 (the latest CREATE OR REPLACE of
// book_guest_cyclus_for_payment) loaded verbatim, sans GRANT/REVOKE — service_role absent in PGlite.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const SPLIT = '10000000-0000-0000-0000-000000000001'; // split_payment=true, allow_single_booking=false, cap 2
const WHOLE = '10000000-0000-0000-0000-000000000002'; // both false, cap 4 → whole-slot, cap 1
const PERSPOT = '10000000-0000-0000-0000-000000000003'; // allow_single_booking=true, cap 2
const PRIVATE = '10000000-0000-0000-0000-000000000004'; // split_payment=true but is_public=false
const G1 = '20000000-0000-0000-0000-000000000001';
const G2 = '20000000-0000-0000-0000-000000000002';
const G3 = '20000000-0000-0000-0000-000000000003';

function readMigrations(): string {
  return ['20260706160000_split_payment_cyclus_capacity.sql']
    .map((f) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8'))
    .join('\n')
    .split('\n')
    .filter((l) => !/^(REVOKE|GRANT)\b/.test(l))
    .join('\n');
}

const bookCyclus = async (guest: string, slots: string[], amounts: number[]): Promise<string[]> => {
  const res = await db.query<{ book_guest_cyclus_for_payment: string[] }>(
    `SELECT public.book_guest_cyclus_for_payment($1::uuid, $2::uuid[], $3::numeric[], 20, NULL)`,
    [guest, slots, amounts],
  );
  return res.rows[0].book_guest_cyclus_for_payment;
};

const count = async (sql: string): Promise<number> =>
  Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`)).rows[0].n);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE availability_slots (
      id uuid PRIMARY KEY, max_participants integer,
      allow_single_booking boolean, split_payment boolean, is_public boolean
    );
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, player_id uuid, guest_player_id uuid,
      status text, payment_status text, payment_amount numeric,
      hold_expires_at timestamptz, notes text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
  `);
  // The real migration file. It also redefines book_guest_slot_for_payment (part B) — unused here,
  // and plpgsql bodies are not column-resolved at CREATE time, so it loads against this harness.
  await db.exec(readMigrations());
});

beforeEach(async () => {
  await db.exec(`DELETE FROM bookings; DELETE FROM availability_slots;
    INSERT INTO availability_slots (id, max_participants, allow_single_booking, split_payment, is_public) VALUES
      ('${SPLIT}', 2, false, true, true),
      ('${WHOLE}', 4, false, false, true),
      ('${PERSPOT}', 2, true, false, true),
      ('${PRIVATE}', 2, false, true, false);`);
});

describe('book_guest_cyclus_for_payment — split_payment capacity (P1-2)', () => {
  it('split_payment (allow_single_booking=false) is per-seat: N distinct guests can each book', async () => {
    // Two different guests each book the (single-session) split cyclus — capacity = max_participants = 2.
    const a = await bookCyclus(G1, [SPLIT], [15]);
    const b = await bookCyclus(G2, [SPLIT], [15]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(await count(`bookings WHERE slot_id = '${SPLIT}'`)).toBe(2);
    // A THIRD guest is refused — capacity 2 is now full.
    await expect(bookCyclus(G3, [SPLIT], [15])).rejects.toThrow(/slot_full/);
    expect(await count(`bookings WHERE slot_id = '${SPLIT}'`)).toBe(2);
  });

  it('non-split whole-slot (both flags false) is UNCHANGED: capacity 1, second guest refused', async () => {
    await bookCyclus(G1, [WHOLE], [40]);
    await expect(bookCyclus(G2, [WHOLE], [40])).rejects.toThrow(/slot_full/);
    expect(await count(`bookings WHERE slot_id = '${WHOLE}'`)).toBe(1);
  });

  it('allow_single_booking=true stays per-seat: capacity max_participants', async () => {
    await bookCyclus(G1, [PERSPOT], [10]);
    await bookCyclus(G2, [PERSPOT], [10]);
    await expect(bookCyclus(G3, [PERSPOT], [10])).rejects.toThrow(/slot_full/);
    expect(await count(`bookings WHERE slot_id = '${PERSPOT}'`)).toBe(2);
  });

  it('a non-public split session is still refused (is_public guard intact)', async () => {
    await expect(bookCyclus(G1, [PRIVATE], [15])).rejects.toThrow(/slot_not_public/);
    expect(await count(`bookings WHERE slot_id = '${PRIVATE}'`)).toBe(0);
  });
});
