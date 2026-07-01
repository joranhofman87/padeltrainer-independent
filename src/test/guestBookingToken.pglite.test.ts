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
    CREATE UNIQUE INDEX bookings_public_token_key ON bookings (public_token) WHERE public_token IS NOT NULL;
  `);
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.get_guest_booking_by_token(_token uuid)
    RETURNS TABLE (
      booking_id uuid, mollie_payment_id text, payment_status text, status text,
      payment_amount numeric, hold_expires_at timestamptz, slot_id uuid,
      start_time timestamptz, end_time timestamptz, cyclus_name text, trainer_id uuid, academy_profile_id uuid
    ) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT b.id, b.mollie_payment_id, b.payment_status, b.status, b.payment_amount, b.hold_expires_at,
             s.id, s.start_time, s.end_time, s.cyclus_name, s.trainer_id, s.academy_profile_id
      FROM public.bookings b JOIN public.availability_slots s ON s.id = b.slot_id
      WHERE b.public_token = _token LIMIT 1;
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

  it('returns no rows for an unknown token', async () => {
    const rows = (await db.query(`SELECT * FROM public.get_guest_booking_by_token('50000000-0000-0000-0000-000000000000'::uuid)`)).rows;
    expect(rows).toHaveLength(0);
  });
});
