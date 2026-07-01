-- Belt-and-suspenders: refuse a guest hold on a NON-PUBLIC slot at the mutation boundary.
--
-- The guest pay-first edge fns now check availability_slots.is_public before minting, but the RPCs
-- are the single mutation boundary (the only place a guest seat is inserted). Enforce is_public here
-- too so a private/unpublished slot can never receive a guest hold even if a future caller forgets
-- the edge guard. is_public is the primary published flag the public read filters on; resolveSlotTier
-- (the windows) does NOT consider it, so this is not covered by the existing capacity/tier logic.
--
-- Re-defines both guest RPCs BYTE-IDENTICAL to 20260704190000 except: (1) a v_is_public declaration,
-- (2) is_public folded into the same capacity SELECT, (3) a RAISE 'slot_not_public' guard. The
-- advisory lock, occupancy predicate, idempotent-hold logic and insert are unchanged.

-- 1) Anonymous guest single-slot pay-first (TTL hold).
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
  v_max       integer;
  v_taken     integer;
  v_hold_min  integer := GREATEST(5, LEAST(60, COALESCE(_hold_minutes, 20)));
  v_existing  uuid;
  v_id        uuid;
  v_is_public boolean;
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

  -- Effective capacity (whole-slot = 1) + is_public in one read; refuse a non-public slot.
  SELECT
    CASE WHEN COALESCE(allow_single_booking, false) THEN COALESCE(max_participants, 1) ELSE 1 END,
    COALESCE(is_public, false)
    INTO v_max, v_is_public FROM public.availability_slots WHERE id = _slot_id;
  IF NOT v_is_public THEN
    RAISE EXCEPTION 'slot_not_public' USING ERRCODE = 'check_violation';
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

-- 2) Anonymous guest WHOLE-CYCLUS pay-first (atomic multi-session hold).
CREATE OR REPLACE FUNCTION public.book_guest_cyclus_for_payment(
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
  v_hold_min  integer := GREATEST(5, LEAST(60, COALESCE(_hold_minutes, 20)));
  v_n         integer := array_length(_slot_ids, 1);
  v_sorted    uuid[];
  v_slot      uuid;
  v_idx       integer;
  v_max       integer;
  v_taken     integer;
  v_existing  uuid;
  v_live      uuid[];
  v_ids       uuid[] := ARRAY[]::uuid[];
  v_id        uuid;
  v_is_public boolean;
BEGIN
  IF v_n IS NULL OR v_n = 0 OR v_n <> array_length(_amounts, 1) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  -- Lock every slot in a deterministic order to avoid deadlocks between two
  -- concurrent cyclus bookings that touch overlapping slots.
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

    -- Effective capacity (whole-slot = 1) + is_public in one read; refuse a non-public session.
    SELECT
      CASE WHEN COALESCE(allow_single_booking, false) THEN COALESCE(max_participants, 1) ELSE 1 END,
      COALESCE(is_public, false)
      INTO v_max, v_is_public FROM public.availability_slots WHERE id = v_slot;
    IF NOT v_is_public THEN
      RAISE EXCEPTION 'slot_not_public' USING ERRCODE = 'check_violation';
    END IF;

    SELECT count(*) INTO v_taken
    FROM public.bookings
    WHERE slot_id = v_slot
      AND (
        COALESCE(status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
        OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now())
      );
    IF v_taken >= COALESCE(v_max, 1) THEN
      RAISE EXCEPTION 'slot_full' USING ERRCODE = 'check_violation';
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
REVOKE ALL ON FUNCTION public.book_guest_cyclus_for_payment(uuid, uuid[], numeric[], integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_guest_cyclus_for_payment(uuid, uuid[], numeric[], integer, text) TO service_role;
