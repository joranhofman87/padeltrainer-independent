-- Whole-slot vs per-spot booking capacity.
--
-- A public slot's `allow_single_booking` flag already drives PRICING (booking-pricing.ts:
-- allow_single_booking=false → the WHOLE slot price; true → price / max_participants per spot).
-- But the three seat-holding RPCs ignored the flag and always capped capacity at
-- max_participants, so a "whole slot" (allow_single_booking=false) could still be booked
-- max_participants times — each at the FULL price — massively overselling one session.
--
-- Fix: make the effective booking capacity respect the flag, so the two layers agree:
--   allow_single_booking = false → capacity 1  (the session is booked AS A WHOLE, full price)
--   allow_single_booking = true  → capacity max_participants  (per-spot, future feature)
--
-- Only the `v_max` derivation changes in each function; the advisory lock, the occupancy
-- predicate (confirmed/pending/pending_approval + live payment_pending holds) and the insert
-- are byte-identical to their prior definitions (20260703140000 / 20260704150000 / 20260704170000).
--
-- SCOPE (intentional): whole-slot capacity is enforced on the PUBLIC PAY-FIRST booking path
-- (these 3 RPCs) + the public read-side (publicAvailability.ts). It is deliberately NOT applied
-- to enforce_booking_slot_tier / swap_member_booking, which guard ACADEMY-MANAGED direct inserts
-- (roster add, manual/approval enrollment via slotBookingWrite.ts / cycleRoster.ts). Those keep the
-- raw max_participants cap so an academy can still enroll multiple players into an allow_single=false
-- group cyclus by hand. "Booked as a whole" is a self-service public-booking guarantee; staff flows
-- stay flexible. Revisit if whole-slot should also bind staff enrollment.

-- 1) Authenticated single-slot pay-first.
CREATE OR REPLACE FUNCTION public.book_slot_for_payment(
  _slot_id uuid,
  _player_id uuid,
  _payment_amount numeric,
  _notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max   integer;
  v_taken integer;
  v_id    uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(_slot_id::text, 0));

  -- Effective capacity: a whole-slot (allow_single_booking=false) holds ONE booking.
  SELECT CASE WHEN COALESCE(allow_single_booking, false) THEN COALESCE(max_participants, 1) ELSE 1 END
    INTO v_max FROM public.availability_slots WHERE id = _slot_id;

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

  INSERT INTO public.bookings (slot_id, player_id, payment_status, status, payment_amount, notes)
  VALUES (_slot_id, _player_id, 'pending', 'pending', _payment_amount, NULLIF(btrim(_notes), ''))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- 2) Anonymous guest single-slot pay-first (TTL hold).
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
  v_max      integer;
  v_taken    integer;
  v_hold_min integer := GREATEST(5, LEAST(60, COALESCE(_hold_minutes, 20)));
  v_existing uuid;
  v_id       uuid;
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

  -- Effective capacity: a whole-slot (allow_single_booking=false) holds ONE booking.
  SELECT CASE WHEN COALESCE(allow_single_booking, false) THEN COALESCE(max_participants, 1) ELSE 1 END
    INTO v_max FROM public.availability_slots WHERE id = _slot_id;

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

-- 3) Anonymous guest WHOLE-CYCLUS pay-first (atomic multi-session hold).
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
  v_hold_min integer := GREATEST(5, LEAST(60, COALESCE(_hold_minutes, 20)));
  v_n        integer := array_length(_slot_ids, 1);
  v_sorted   uuid[];
  v_slot     uuid;
  v_idx      integer;
  v_max      integer;
  v_taken    integer;
  v_existing uuid;
  v_live     uuid[];
  v_ids      uuid[] := ARRAY[]::uuid[];
  v_id       uuid;
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

    -- Effective capacity: a whole-slot (allow_single_booking=false) holds ONE booking.
    SELECT CASE WHEN COALESCE(allow_single_booking, false) THEN COALESCE(max_participants, 1) ELSE 1 END
      INTO v_max FROM public.availability_slots WHERE id = v_slot;

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

REVOKE ALL ON FUNCTION public.book_slot_for_payment(uuid, uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_slot_for_payment(uuid, uuid, numeric, text) TO service_role;
REVOKE ALL ON FUNCTION public.book_guest_slot_for_payment(uuid, uuid, numeric, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_guest_slot_for_payment(uuid, uuid, numeric, integer, text) TO service_role;
REVOKE ALL ON FUNCTION public.book_guest_cyclus_for_payment(uuid, uuid[], numeric[], integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_guest_cyclus_for_payment(uuid, uuid[], numeric[], integer, text) TO service_role;
