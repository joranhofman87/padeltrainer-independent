// @vitest-environment node
// Integration test for get_guest_booking_by_token (migration 20260704160000) against real Postgres
// via PGlite. Function body copied verbatim from the migration (sans GRANT/REVOKE — service_role
// absent in PGlite); `supabase db reset` validates the migration itself.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

const SLOT = '10000000-0000-0000-0000-000000000001';
const TRAINER = '30000000-0000-0000-0000-000000000001';
const TOKEN = '40000000-0000-0000-0000-000000000009';

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE availability_slots (
      id uuid PRIMARY KEY, start_time timestamptz, end_time timestamptz,
      cyclus_name text, trainer_id uuid, academy_profile_id uuid
    );
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, guest_player_id uuid,
      status text, payment_status text, payment_amount numeric,
      mollie_payment_id text, hold_expires_at timestamptz, public_token uuid
    );
    CREATE INDEX bookings_public_token_idx ON bookings (public_token) WHERE public_token IS NOT NULL;
  `);
  // Aggregate form from migration 20260704180000 (cyclus-aware: earliest session,
  // total amount, session count).
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.get_guest_booking_by_token(_token uuid)
    RETURNS TABLE (
      booking_id uuid, mollie_payment_id text, payment_status text, status text,
      payment_amount numeric, hold_expires_at timestamptz, slot_id uuid,
      start_time timestamptz, end_time timestamptz, cyclus_name text, trainer_id uuid,
      academy_profile_id uuid, session_count integer
    ) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT b.id, b.mollie_payment_id, b.payment_status, b.status,
             (SELECT sum(b2.payment_amount) FROM public.bookings b2 WHERE b2.public_token = _token),
             b.hold_expires_at, s.id, s.start_time, s.end_time, s.cyclus_name, s.trainer_id, s.academy_profile_id,
             (SELECT count(*)::int FROM public.bookings b3 WHERE b3.public_token = _token)
      FROM public.bookings b JOIN public.availability_slots s ON s.id = b.slot_id
      WHERE b.public_token = _token ORDER BY s.start_time ASC LIMIT 1;
    $$;
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM bookings; DELETE FROM availability_slots;
    INSERT INTO availability_slots (id, start_time, end_time, cyclus_name, trainer_id)
      VALUES ('${SLOT}', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z', NULL, '${TRAINER}');`);
});

describe('get_guest_booking_by_token', () => {
  it('returns the guest booking + slot fields for a valid token', async () => {
    await db.query(
      `INSERT INTO bookings (slot_id, guest_player_id, status, payment_status, payment_amount, mollie_payment_id, public_token)
       VALUES ('${SLOT}','20000000-0000-0000-0000-000000000001','payment_pending','pending', 20, 'tr_abc', '${TOKEN}')`,
    );
    const rows = (
      await db.query<{ status: string; payment_status: string; trainer_id: string; start_time: string; payment_amount: number }>(
        `SELECT * FROM public.get_guest_booking_by_token('${TOKEN}'::uuid)`,
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('payment_pending');
    expect(rows[0].payment_status).toBe('pending');
    expect(rows[0].trainer_id).toBe(TRAINER);
    expect(Number(rows[0].payment_amount)).toBe(20);
  });

  it('aggregates a cyclus token: earliest session, total amount, session count', async () => {
    const S2 = '10000000-0000-0000-0000-000000000002';
    const S3 = '10000000-0000-0000-0000-000000000003';
    await db.query(
      `INSERT INTO availability_slots (id, start_time, end_time, cyclus_name, trainer_id) VALUES
        ('${S2}','2026-09-08T10:00:00Z','2026-09-08T11:00:00Z','Beginners A','${TRAINER}'),
        ('${S3}','2026-09-15T10:00:00Z','2026-09-15T11:00:00Z','Beginners A','${TRAINER}')`,
    );
    // Earliest is S3-ordering? No — insert three bookings with the same token; the
    // representative must be the chronologically earliest slot (S2 @ 09-08).
    await db.query(
      `INSERT INTO bookings (slot_id, guest_player_id, status, payment_status, payment_amount, public_token) VALUES
        ('${SLOT}','20000000-0000-0000-0000-000000000001','payment_pending','pending', 12, '${TOKEN}'),
        ('${S2}',  '20000000-0000-0000-0000-000000000001','payment_pending','pending', 12, '${TOKEN}'),
        ('${S3}',  '20000000-0000-0000-0000-000000000001','payment_pending','pending', 12, '${TOKEN}')`,
    );
    // SLOT is 09-01 (earliest of the three), so it is the representative.
    const rows = (
      await db.query<{ start_time: string; payment_amount: number; session_count: number }>(
        `SELECT * FROM public.get_guest_booking_by_token('${TOKEN}'::uuid)`,
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].session_count).toBe(3);
    expect(Number(rows[0].payment_amount)).toBe(36); // sum across the token
    expect(new Date(rows[0].start_time).toISOString()).toBe('2026-09-01T10:00:00.000Z');
  });

  it('returns no rows for an unknown token', async () => {
    const rows = (await db.query(`SELECT * FROM public.get_guest_booking_by_token('50000000-0000-0000-0000-000000000000'::uuid)`)).rows;
    expect(rows).toHaveLength(0);
  });
});
