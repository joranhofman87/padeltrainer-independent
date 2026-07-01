// @vitest-environment node
// Integration test for the guest single-slot pay-first RPCs (migration 20260704150000) against real
// Postgres via PGlite. The function bodies below are copied verbatim from the migration (sans the
// GRANT/REVOKE/cron, whose roles + pg_cron don't exist in PGlite); `supabase db reset` in CI
// validates the migration itself applies. This test exercises the capacity/hold/sweep LOGIC.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

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
    CREATE TABLE availability_slots (id uuid PRIMARY KEY, max_participants integer, allow_single_booking boolean, is_public boolean);
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, player_id uuid, guest_player_id uuid,
      status text, payment_status text, payment_amount numeric,
      hold_expires_at timestamptz, notes text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
  `);
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.book_guest_slot_for_payment(
      _slot_id uuid, _guest_player_id uuid, _payment_amount numeric,
      _hold_minutes integer DEFAULT 20, _notes text DEFAULT NULL
    ) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE
      v_max integer; v_taken integer; v_is_public boolean;
      v_hold_min integer := GREATEST(5, LEAST(60, COALESCE(_hold_minutes, 20)));
      v_existing uuid; v_id uuid;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended(_slot_id::text, 0));
      SELECT id INTO v_existing FROM public.bookings
       WHERE slot_id = _slot_id AND guest_player_id = _guest_player_id
         AND status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now() LIMIT 1;
      IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
      SELECT CASE WHEN COALESCE(allow_single_booking, false) THEN COALESCE(max_participants, 1) ELSE 1 END,
             COALESCE(is_public, false)
        INTO v_max, v_is_public FROM public.availability_slots WHERE id = _slot_id;
      IF NOT v_is_public THEN RAISE EXCEPTION 'slot_not_public' USING ERRCODE = 'check_violation'; END IF;
      SELECT count(*) INTO v_taken FROM public.bookings
       WHERE slot_id = _slot_id AND (
         COALESCE(status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
         OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now()));
      IF v_taken >= COALESCE(v_max, 1) THEN RAISE EXCEPTION 'slot_full' USING ERRCODE = 'check_violation'; END IF;
      INSERT INTO public.bookings (slot_id, guest_player_id, payment_status, status, payment_amount, hold_expires_at, notes)
      VALUES (_slot_id, _guest_player_id, 'pending', 'payment_pending', _payment_amount,
              now() + make_interval(mins => v_hold_min), NULLIF(btrim(_notes), '')) RETURNING id INTO v_id;
      RETURN v_id;
    END; $$;
    CREATE OR REPLACE FUNCTION public.release_expired_guest_slot_holds()
    RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE v_n integer;
    BEGIN
      UPDATE public.bookings SET status = 'cancelled', updated_at = now()
       WHERE status = 'payment_pending' AND guest_player_id IS NOT NULL AND payment_status = 'pending'
         AND hold_expires_at IS NOT NULL AND hold_expires_at < now();
      GET DIAGNOSTICS v_n = ROW_COUNT; RETURN v_n;
    END; $$;
  `);
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
