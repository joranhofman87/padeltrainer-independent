-- whole_slot_booking — sell a CYCLUS session individually as the WHOLE slot at FULL price.
-- First user: RL Padel Performance (drop-in whole-court sessions; max_participants stays the
-- ATTENDEE count for staff-side registration, which deliberately uses the raw maxP cap —
-- see 20260702120000's scope note).
--
-- Design: the flag PERMITS, it never reprices. allow_single_booking=false already yields the
-- wanted money behavior everywhere (full price via computeSingleSlotPaymentAmount, capacity 1
-- via the CASE below and the read-side bookingCapacity). The only blocker for cyclus sessions
-- is the single_booking_not_allowed guard (20260706160000 (B)) — this migration loosens THAT
-- guard alone; both capacity CASEs stay byte-identical.
--
-- SPLIT EXCLUSION (critical): the unlock is `whole_slot AND NOT split_payment`. A split cyclus
-- session is per-seat (capacity N via the cyclus RPC, priced total÷N) — admitting a FULL-price
-- single hold on one would recreate the exact over-collection 20260706160000 (B) fixed. The
-- writers never produce split+whole_slot, but this endpoint serves verify_jwt=false traffic,
-- so the combination is refused here regardless of data state.

ALTER TABLE public.availability_slots
  ADD COLUMN IF NOT EXISTS whole_slot_booking boolean NOT NULL DEFAULT false;

-- (A) Guest single-slot pay-first — byte-identical to 20260706160000 (B) except:
-- whole_slot_booking + split_payment join the capacity SELECT, and the
-- single_booking_not_allowed guard admits a whole-slot (non-split) session.
CREATE OR REPLACE FUNCTION public.book_guest_slot_for_payment(
  _slot_id uuid,
  _guest_player_id uuid,
  _payment_amount numeric,
  _hold_minutes integer DEFAULT 20,
  _notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max          integer;
  v_taken        integer;
  v_hold_min     integer := GREATEST(5, LEAST(60, COALESCE(_hold_minutes, 20)));
  v_existing     uuid;
  v_id           uuid;
  v_is_public    boolean;
  v_cyclus_id    uuid;
  v_allow_single boolean;
  v_whole_slot   boolean;
  v_split        boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(_slot_id::text, 0));

  -- Re-clicking "book" returns this guest's existing LIVE hold on the slot instead of stacking a
  -- second hold + a second Mollie payment.
  SELECT id INTO v_existing
  FROM public.bookings
  WHERE slot_id = _slot_id
    AND guest_player_id = _guest_player_id
    AND status = 'payment_pending'
    AND hold_expires_at IS NOT NULL
    AND hold_expires_at > now()
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- Effective capacity (whole-slot = 1) + is_public + the cyclus/booking-mode flags in one read.
  SELECT
    CASE WHEN COALESCE(allow_single_booking, false) THEN COALESCE(max_participants, 1) ELSE 1 END,
    COALESCE(is_public, false),
    cyclus_id,
    COALESCE(allow_single_booking, false),
    COALESCE(whole_slot_booking, false),
    COALESCE(split_payment, false)
    INTO v_max, v_is_public, v_cyclus_id, v_allow_single, v_whole_slot, v_split
    FROM public.availability_slots WHERE id = _slot_id;
  IF NOT v_is_public THEN
    RAISE EXCEPTION 'slot_not_public' USING ERRCODE = 'check_violation';
  END IF;

  -- A single session of a CYCLUS may be booked on its own when the owner enabled per-seat
  -- booking (allow_single_booking) OR whole-slot selling (whole_slot_booking, non-split: one
  -- booking claims the entire session at the full price — capacity stays 1 via the CASE above).
  -- Split sessions are NEVER single-bookable at full price (per-seat total÷N via the cyclus
  -- path) — that would over-collect (20260706160000 (B)).
  IF v_cyclus_id IS NOT NULL AND NOT v_allow_single AND NOT (v_whole_slot AND NOT v_split) THEN
    RAISE EXCEPTION 'single_booking_not_allowed' USING ERRCODE = 'check_violation';
  END IF;

  -- Capacity predicate — identical to book_slot_for_payment: occupied = active bookings OR a still-
  -- live payment_pending hold (expired holds are ignored, so capacity self-heals).
  SELECT count(*) INTO v_taken
  FROM public.bookings
  WHERE slot_id = _slot_id
    AND (
      COALESCE(status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
      OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now())
    );

  IF v_taken >= COALESCE(v_max, 1) THEN
    RAISE EXCEPTION 'slot_full' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.bookings (slot_id, guest_player_id, payment_status, status, payment_amount, hold_expires_at, notes)
  VALUES (
    _slot_id,
    _guest_player_id,
    'pending',
    'payment_pending',
    _payment_amount,
    now() + make_interval(mins => v_hold_min),
    NULLIF(btrim(_notes), '')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- (B) Guest CART pay-first — byte-identical to 20260707100000 except the same loosened guard
-- (whole_slot_booking joins the guard SELECT; split_not_supported still fires FIRST for split
-- slots, so the whole-slot unlock can never touch a split session here).
CREATE OR REPLACE FUNCTION public.book_guest_cart_for_payment(
  _guest_player_id uuid,
  _slot_ids uuid[],
  _amounts numeric[],
  _hold_minutes integer DEFAULT 20,
  _notes text DEFAULT NULL
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hold_min     integer := GREATEST(5, LEAST(60, COALESCE(_hold_minutes, 20)));
  v_n            integer := array_length(_slot_ids, 1);
  v_sorted       uuid[];
  v_slot         uuid;
  v_idx          integer;
  v_max          integer;
  v_taken        integer;
  v_existing     uuid;
  v_live         uuid[];
  v_ids          uuid[] := ARRAY[]::uuid[];
  v_id           uuid;
  v_is_public    boolean;
  v_cyclus_id    uuid;
  v_allow_single boolean;
  v_whole_slot   boolean;
  v_split        boolean;
BEGIN
  IF v_n IS NULL OR v_n = 0 OR v_n <> array_length(_amounts, 1) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  -- Duplicate slot ids would reuse one hold twice and desync the amounts distribution.
  IF (SELECT count(DISTINCT s) FROM unnest(_slot_ids) AS s) <> v_n THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  -- Lock every slot in a deterministic order to avoid deadlocks between two
  -- concurrent carts that touch overlapping slots.
  SELECT array_agg(s ORDER BY s) INTO v_sorted FROM unnest(_slot_ids) AS s;
  FOREACH v_slot IN ARRAY v_sorted LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_slot::text, 0));
  END LOOP;

  -- Idempotent re-click: if this guest already holds a LIVE seat on EVERY slot,
  -- return those instead of stacking a second set of holds + a second payment.
  SELECT array_agg(id) INTO v_live
  FROM public.bookings
  WHERE slot_id = ANY(_slot_ids)
    AND guest_player_id = _guest_player_id
    AND status = 'payment_pending'
    AND hold_expires_at IS NOT NULL
    AND hold_expires_at > now();
  IF v_live IS NOT NULL AND array_length(v_live, 1) = v_n THEN
    RETURN v_live;
  END IF;

  -- Otherwise create the missing holds (reusing any live partial holds), all in
  -- this one transaction. Preserve input order so amounts line up with slots.
  FOR v_idx IN 1 .. v_n LOOP
    v_slot := _slot_ids[v_idx];

    SELECT id INTO v_existing
    FROM public.bookings
    WHERE slot_id = v_slot
      AND guest_player_id = _guest_player_id
      AND status = 'payment_pending'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at > now()
    LIMIT 1;
    IF v_existing IS NOT NULL THEN
      v_ids := array_append(v_ids, v_existing);
      CONTINUE;
    END IF;

    -- Single-slot capacity semantics (whole-slot = 1 unless per-seat) + all guard
    -- inputs in one read.
    SELECT
      CASE WHEN COALESCE(allow_single_booking, false) THEN COALESCE(max_participants, 1) ELSE 1 END,
      COALESCE(is_public, false),
      cyclus_id,
      COALESCE(allow_single_booking, false),
      COALESCE(whole_slot_booking, false),
      COALESCE(split_payment, false)
      INTO v_max, v_is_public, v_cyclus_id, v_allow_single, v_whole_slot, v_split
      FROM public.availability_slots WHERE id = v_slot;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'slot_unavailable' USING ERRCODE = 'check_violation', DETAIL = v_slot::text;
    END IF;
    IF NOT v_is_public THEN
      RAISE EXCEPTION 'slot_not_public' USING ERRCODE = 'check_violation', DETAIL = v_slot::text;
    END IF;
    IF v_split THEN
      RAISE EXCEPTION 'split_not_supported' USING ERRCODE = 'check_violation', DETAIL = v_slot::text;
    END IF;
    IF v_cyclus_id IS NOT NULL AND NOT v_allow_single AND NOT v_whole_slot THEN
      RAISE EXCEPTION 'single_booking_not_allowed' USING ERRCODE = 'check_violation', DETAIL = v_slot::text;
    END IF;

    SELECT count(*) INTO v_taken
    FROM public.bookings
    WHERE slot_id = v_slot
      AND (
        COALESCE(status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
        OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now())
      );
    IF v_taken >= COALESCE(v_max, 1) THEN
      RAISE EXCEPTION 'slot_full' USING ERRCODE = 'check_violation', DETAIL = v_slot::text;
    END IF;

    INSERT INTO public.bookings (slot_id, guest_player_id, payment_status, status, payment_amount, hold_expires_at, notes)
    VALUES (
      v_slot,
      _guest_player_id,
      'pending',
      'payment_pending',
      _amounts[v_idx],
      now() + make_interval(mins => v_hold_min),
      NULLIF(btrim(_notes), '')
    )
    RETURNING id INTO v_id;
    v_ids := array_append(v_ids, v_id);
  END LOOP;

  RETURN v_ids;
END;
$$;

REVOKE ALL ON FUNCTION public.book_guest_slot_for_payment(uuid, uuid, numeric, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_guest_slot_for_payment(uuid, uuid, numeric, integer, text) TO service_role;
REVOKE ALL ON FUNCTION public.book_guest_cart_for_payment(uuid, uuid[], numeric[], integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_guest_cart_for_payment(uuid, uuid[], numeric[], integer, text) TO service_role;
