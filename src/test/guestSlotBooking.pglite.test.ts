// @vitest-environment node
// Integration test for the guest single-slot pay-first RPCs against real Postgres via PGlite.
// Runs the REAL deployed SQL: 20260704150000_guest_slot_booking.sql (release_expired_guest_slot_holds —
// its only/current definition) then 20260707140000_whole_slot_booking.sql (the CURRENT
// book_guest_slot_for_payment, superseding 20260704150000/190000/210000/20260706160000). Only
// REVOKE/GRANT lines are stripped (roles don't exist in PGlite); the pg_cron schedule block
// self-guards on pg_extension and no-ops here. This test exercises the capacity/hold/sweep LOGIC.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigrations(): string {
  return ['20260704150000_guest_slot_booking.sql', '20260707140000_whole_slot_booking.sql']
    .map((f) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8'))
    .join('\n')
    .split('\n')
    .filter((l) => !/^(REVOKE|GRANT)\b/.test(l))
    .join('\n');
}

let db: PGlite;

const SLOT = '10000000-0000-0000-0000-000000000001';
const G1 = '20000000-0000-0000-0000-000000000001';
const G2 = '20000000-0000-0000-0000-000000000002';
const G3 = '20000000-0000-0000-0000-000000000003';

const book = async (guest: string, holdMin = 20): Promise<string> =>
  (
    await db.query<{ id: string }>(
      `SELECT public.book_guest_slot_for_payment($1::uuid, $2::uuid, 20, ${holdMin}, NULL) AS id`,
      [SLOT, guest],
    )
  ).rows[0].id;

const count = async (sql: string): Promise<number> =>
  Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`)).rows[0].n);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE availability_slots (id uuid PRIMARY KEY, max_participants integer, allow_single_booking boolean, is_public boolean, cyclus_id uuid, split_payment boolean);
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, player_id uuid, guest_player_id uuid,
      status text, payment_status text, payment_amount numeric,
      hold_expires_at timestamptz, notes text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
  `);
  await db.exec(readMigrations()); // 20260707140000 ALTERs whole_slot_booking onto the table itself
});

beforeEach(async () => {
  await db.exec(
    // allow_single_booking=true so effective capacity = max_participants (2) for the capacity tests.
    `DELETE FROM bookings; DELETE FROM availability_slots;
     INSERT INTO availability_slots (id, max_participants, allow_single_booking, is_public) VALUES ('${SLOT}', 2, true, true);`,
  );
});

describe('book_guest_slot_for_payment', () => {
  it('commits a guest hold: payment_pending + guest_player_id + a live TTL', async () => {
    const id = await book(G1);
    const b = (
      await db.query<{ status: string; payment_status: string; guest_player_id: string; live: boolean }>(
        `SELECT status, payment_status, guest_player_id, (hold_expires_at > now()) AS live FROM bookings WHERE id = '${id}'`,
      )
    ).rows[0];
    expect(b.status).toBe('payment_pending');
    expect(b.payment_status).toBe('pending');
    expect(b.guest_player_id).toBe(G1);
    expect(b.live).toBe(true);
  });

  it('re-booking returns the SAME live hold (no duplicate seat / payment)', async () => {
    const a = await book(G1);
    const b = await book(G1);
    expect(b).toBe(a);
    expect(await count(`bookings WHERE guest_player_id = '${G1}'`)).toBe(1);
  });

  it('raises slot_full once capacity (live holds included) is reached', async () => {
    await book(G1); // 1/2
    await book(G2); // 2/2
    await expect(
      db.query(`SELECT public.book_guest_slot_for_payment('${SLOT}'::uuid, '${G3}'::uuid, 20, 20, NULL)`),
    ).rejects.toThrow(/slot_full/);
  });

  it('refuses a NON-PUBLIC slot (is_public=false) even with capacity — slot_not_public', async () => {
    await db.exec(`UPDATE availability_slots SET is_public = false WHERE id = '${SLOT}'`);
    await expect(
      db.query(`SELECT public.book_guest_slot_for_payment('${SLOT}'::uuid, '${G1}'::uuid, 20, 20, NULL)`),
    ).rejects.toThrow(/slot_not_public/);
    expect(await count(`bookings WHERE slot_id = '${SLOT}'`)).toBe(0);
  });

  it('whole-slot (allow_single_booking=false) is capacity 1 — a second guest is refused', async () => {
    await db.exec(`UPDATE availability_slots SET allow_single_booking = false WHERE id = '${SLOT}'`);
    await book(G1); // 1/1
    await expect(
      db.query(`SELECT public.book_guest_slot_for_payment('${SLOT}'::uuid, '${G2}'::uuid, 20, 20, NULL)`),
    ).rejects.toThrow(/slot_full/);
  });

  it('EXPIRED holds do not occupy capacity — a new hold succeeds', async () => {
    await db.query(
      `INSERT INTO bookings (slot_id, guest_player_id, status, payment_status, hold_expires_at) VALUES
        ('${SLOT}','${G1}','payment_pending','pending', now() - interval '1 minute'),
        ('${SLOT}','${G2}','payment_pending','pending', now() - interval '1 minute')`,
    );
    const id = await book(G3);
    expect(id).toBeTruthy();
  });
});

describe('book_guest_slot_for_payment — single-session cyclus guard (P1-2)', () => {
  const CYC = '10000000-0000-0000-0000-0000000000c1';
  const CYCLUS = '30000000-0000-0000-0000-000000000001';
  const bookCyc = (guest: string) =>
    db.query(`SELECT public.book_guest_slot_for_payment('${CYC}'::uuid, '${guest}'::uuid, 20, 20, NULL)`);

  it('REFUSES a single-session hold on a cyclus session when allow_single_booking=false', async () => {
    // The exact split-payment shape: a cyclus session the owner did NOT open to single booking.
    await db.exec(`INSERT INTO availability_slots (id, max_participants, allow_single_booking, is_public, cyclus_id)
      VALUES ('${CYC}', 4, false, true, '${CYCLUS}')`);
    await expect(bookCyc(G1)).rejects.toThrow(/single_booking_not_allowed/);
    expect(await count(`bookings WHERE slot_id = '${CYC}'`)).toBe(0);
  });

  it('ALLOWS a single-session hold on a cyclus session when allow_single_booking=true', async () => {
    await db.exec(`INSERT INTO availability_slots (id, max_participants, allow_single_booking, is_public, cyclus_id)
      VALUES ('${CYC}', 4, true, true, '${CYCLUS}')`);
    await bookCyc(G1);
    expect(await count(`bookings WHERE slot_id = '${CYC}'`)).toBe(1);
  });

  it('ALLOWS a standalone (non-cyclus) allow_single_booking=false slot — the whole-slot case is untouched', async () => {
    await db.exec(`INSERT INTO availability_slots (id, max_participants, allow_single_booking, is_public, cyclus_id)
      VALUES ('${CYC}', 4, false, true, NULL)`);
    await bookCyc(G1);
    expect(await count(`bookings WHERE slot_id = '${CYC}'`)).toBe(1);
  });
});

describe('release_expired_guest_slot_holds', () => {
  it('cancels only expired UNPAID guest holds; keeps live + paid', async () => {
    await db.query(
      `INSERT INTO bookings (slot_id, guest_player_id, status, payment_status, hold_expires_at) VALUES
        ('${SLOT}','${G1}','payment_pending','pending', now() - interval '1 minute'),
        ('${SLOT}','${G2}','payment_pending','pending', now() + interval '10 minutes'),
        ('${SLOT}','${G3}','payment_pending','paid',    now() - interval '1 minute')`,
    );
    const n = Number((await db.query<{ n: number }>(`SELECT public.release_expired_guest_slot_holds() AS n`)).rows[0].n);
    expect(n).toBe(1);
    expect(await count(`bookings WHERE status = 'cancelled'`)).toBe(1);
    expect(await count(`bookings WHERE status = 'payment_pending'`)).toBe(2);
  });
});
