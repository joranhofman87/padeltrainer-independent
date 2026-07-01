// @vitest-environment node
// Integration test for book_guest_cyclus_for_payment (migration 20260704170000) against real
// Postgres via PGlite. Function body copied verbatim from the migration (sans GRANT/REVOKE —
// service_role absent in PGlite); `supabase db reset` validates the migration itself.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

const S1 = '10000000-0000-0000-0000-000000000001';
const S2 = '10000000-0000-0000-0000-000000000002';
const S3 = '10000000-0000-0000-0000-000000000003';
const G1 = '20000000-0000-0000-0000-000000000001';
const G2 = '20000000-0000-0000-0000-000000000002';

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
    CREATE TABLE availability_slots (id uuid PRIMARY KEY, max_participants integer);
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, player_id uuid, guest_player_id uuid,
      status text, payment_status text, payment_amount numeric,
      hold_expires_at timestamptz, notes text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
  `);
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.book_guest_cyclus_for_payment(
      _guest_player_id uuid, _slot_ids uuid[], _amounts numeric[],
      _hold_minutes integer DEFAULT 20, _notes text DEFAULT NULL
    ) RETURNS uuid[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE
      v_hold_min integer := GREATEST(5, LEAST(60, COALESCE(_hold_minutes, 20)));
      v_n integer := array_length(_slot_ids, 1);
      v_sorted uuid[]; v_slot uuid; v_idx integer; v_max integer; v_taken integer;
      v_existing uuid; v_live uuid[]; v_ids uuid[] := ARRAY[]::uuid[]; v_id uuid;
    BEGIN
      IF v_n IS NULL OR v_n = 0 OR v_n <> array_length(_amounts, 1) THEN RAISE EXCEPTION 'invalid_input'; END IF;
      SELECT array_agg(s ORDER BY s) INTO v_sorted FROM unnest(_slot_ids) AS s;
      FOREACH v_slot IN ARRAY v_sorted LOOP PERFORM pg_advisory_xact_lock(hashtextextended(v_slot::text, 0)); END LOOP;
      SELECT array_agg(id) INTO v_live FROM public.bookings
       WHERE slot_id = ANY(_slot_ids) AND guest_player_id = _guest_player_id
         AND status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now();
      IF v_live IS NOT NULL AND array_length(v_live, 1) = v_n THEN RETURN v_live; END IF;
      FOR v_idx IN 1 .. v_n LOOP
        v_slot := _slot_ids[v_idx];
        SELECT id INTO v_existing FROM public.bookings
         WHERE slot_id = v_slot AND guest_player_id = _guest_player_id
           AND status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now() LIMIT 1;
        IF v_existing IS NOT NULL THEN v_ids := array_append(v_ids, v_existing); CONTINUE; END IF;
        SELECT max_participants INTO v_max FROM public.availability_slots WHERE id = v_slot;
        SELECT count(*) INTO v_taken FROM public.bookings
         WHERE slot_id = v_slot AND (
           COALESCE(status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
           OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now()));
        IF v_taken >= COALESCE(v_max, 1) THEN RAISE EXCEPTION 'slot_full' USING ERRCODE = 'check_violation'; END IF;
        INSERT INTO public.bookings (slot_id, guest_player_id, payment_status, status, payment_amount, hold_expires_at, notes)
        VALUES (v_slot, _guest_player_id, 'pending', 'payment_pending', _amounts[v_idx],
                now() + make_interval(mins => v_hold_min), NULLIF(btrim(_notes), '')) RETURNING id INTO v_id;
        v_ids := array_append(v_ids, v_id);
      END LOOP;
      RETURN v_ids;
    END; $$;
  `);
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
