// @vitest-environment node
// Public-booking audit P1-2: book_guest_cyclus_for_payment must treat a split_payment session as
// PER-SEAT (capacity max_participants) so N guests can each book the whole series and each pay
// total ÷ N. Before 20260706160000 the capacity keyed off allow_single_booking only, so a
// split_payment + allow_single_booking=false cyclus capped at 1 — only the first guest could book.
//
// Function body copied verbatim from migration 20260706160000 (sans GRANT/REVOKE — service_role
// absent in PGlite); `supabase db reset` validates the migration itself.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

const SPLIT = '10000000-0000-0000-0000-000000000001'; // split_payment=true, allow_single_booking=false, cap 2
const WHOLE = '10000000-0000-0000-0000-000000000002'; // both false, cap 4 → whole-slot, cap 1
const PERSPOT = '10000000-0000-0000-0000-000000000003'; // allow_single_booking=true, cap 2
const PRIVATE = '10000000-0000-0000-0000-000000000004'; // split_payment=true but is_public=false
const G1 = '20000000-0000-0000-0000-000000000001';
const G2 = '20000000-0000-0000-0000-000000000002';
const G3 = '20000000-0000-0000-0000-000000000003';

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
  // Verbatim from 20260706160000 (the ONLY change vs 20260704210000 is the capacity CASE).
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.book_guest_cyclus_for_payment(
      _guest_player_id uuid, _slot_ids uuid[], _amounts numeric[],
      _hold_minutes integer DEFAULT 20, _notes text DEFAULT NULL
    ) RETURNS uuid[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE
      v_hold_min integer := GREATEST(5, LEAST(60, COALESCE(_hold_minutes, 20)));
      v_n integer := array_length(_slot_ids, 1);
      v_sorted uuid[]; v_slot uuid; v_idx integer; v_max integer; v_taken integer;
      v_existing uuid; v_live uuid[]; v_ids uuid[] := ARRAY[]::uuid[]; v_id uuid; v_is_public boolean;
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
        SELECT
          CASE WHEN COALESCE(split_payment, false) OR COALESCE(allow_single_booking, false)
               THEN COALESCE(max_participants, 1) ELSE 1 END,
          COALESCE(is_public, false)
          INTO v_max, v_is_public FROM public.availability_slots WHERE id = v_slot;
        IF NOT v_is_public THEN RAISE EXCEPTION 'slot_not_public' USING ERRCODE = 'check_violation'; END IF;
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
