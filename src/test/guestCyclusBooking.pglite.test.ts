// @vitest-environment node
// Integration test for book_guest_cyclus_for_payment against real Postgres via PGlite.
// Runs the REAL deployed SQL: 20260706160000_split_payment_cyclus_capacity.sql holds the CURRENT
// CREATE OR REPLACE (supersedes 20260704170000/190000/210000; no later recreation exists — the
// cart migration 20260707100000 only references it in a comment). GRANT/REVOKE lines are filtered
// (service_role absent in PGlite); `supabase db reset` validates the migration itself.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const S1 = '10000000-0000-0000-0000-000000000001';
const S2 = '10000000-0000-0000-0000-000000000002';
const S3 = '10000000-0000-0000-0000-000000000003';
const G1 = '20000000-0000-0000-0000-000000000001';
const G2 = '20000000-0000-0000-0000-000000000002';

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
  // availability_slots columns the real SQL reads, with their PROD defaults (20260208130600 /
  // 20260208214926 / 20260325170740) so fixtures inserting only (id, max_participants) behave
  // exactly like prod rows: public, non-split, no single-session booking.
  await db.exec(`
    CREATE TABLE availability_slots (
      id uuid PRIMARY KEY,
      max_participants integer,
      is_public boolean NOT NULL DEFAULT true,
      allow_single_booking boolean DEFAULT false,
      split_payment boolean DEFAULT false,
      cyclus_id uuid
    );
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, player_id uuid, guest_player_id uuid,
      status text, payment_status text, payment_amount numeric,
      hold_expires_at timestamptz, notes text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
  `);
  await db.exec(readMigrations());
});

beforeEach(async () => {
  await db.exec(`DELETE FROM bookings; DELETE FROM availability_slots;
    INSERT INTO availability_slots (id, max_participants) VALUES
      ('${S1}', 2), ('${S2}', 2), ('${S3}', 1);`);
});

describe('book_guest_cyclus_for_payment', () => {
  it('atomically holds every session with the distributed amounts', async () => {
    const ids = await bookCyclus(G1, [S1, S2, S3], [10, 10, 10]);
    expect(ids).toHaveLength(3);
    expect(await count(`bookings WHERE guest_player_id = '${G1}' AND status = 'payment_pending'`)).toBe(3);
    const amt = Number(
      (await db.query<{ s: number }>(`SELECT sum(payment_amount)::numeric AS s FROM bookings WHERE guest_player_id = '${G1}'`)).rows[0].s,
    );
    expect(amt).toBe(30);
  });

  it('rolls back ALL holds when any session is full (all-or-nothing)', async () => {
    // Fill S3 (capacity 1) so the cyclus can't be fully booked.
    await db.query(
      `INSERT INTO bookings (slot_id, guest_player_id, status, payment_status) VALUES ('${S3}','${G2}','confirmed','paid')`,
    );
    await expect(bookCyclus(G1, [S1, S2, S3], [10, 10, 10])).rejects.toThrow(/slot_full/);
    // No partial holds for G1 — the whole transaction rolled back.
    expect(await count(`bookings WHERE guest_player_id = '${G1}'`)).toBe(0);
  });

  it('is idempotent: a re-click returns the same holds (no duplicates)', async () => {
    const a = await bookCyclus(G1, [S1, S2, S3], [10, 10, 10]);
    const b = await bookCyclus(G1, [S1, S2, S3], [10, 10, 10]);
    expect(new Set(b)).toEqual(new Set(a));
    expect(await count(`bookings WHERE guest_player_id = '${G1}'`)).toBe(3);
  });

  it('reuses a live partial hold and creates the missing ones', async () => {
    // A prior attempt left a single live hold on S1.
    await db.query(
      `INSERT INTO bookings (slot_id, guest_player_id, status, payment_status, hold_expires_at)
       VALUES ('${S1}','${G1}','payment_pending','pending', now() + interval '10 minutes')`,
    );
    const ids = await bookCyclus(G1, [S1, S2, S3], [10, 10, 10]);
    expect(ids).toHaveLength(3);
    expect(await count(`bookings WHERE guest_player_id = '${G1}'`)).toBe(3); // not 4 — S1 reused
  });
});
