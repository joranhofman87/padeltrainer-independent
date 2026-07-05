-- Public-booking audit P1-2: split-payment cyclus was uncompletable AND underpaid.
--
-- A split_payment cyclus is inherently PER-SEAT: N guests each run create-guest-cyclus-payment and
-- each pay total ÷ N (resolveSplitDivisorFromSlots = MAX(max_participants)), so every session must
-- hold N bookings. But book_guest_cyclus_for_payment derived capacity from allow_single_booking ONLY
-- (whole-slot = 1). The common split config is split_payment=true + allow_single_booking=false
-- ("split the whole series among the group; you can't book a lone session") → capacity 1. Result:
-- only the FIRST guest could book (guests 2..N got slot_full) and that one guest paid just total/N —
-- the court was underpaid by (N-1)/N and the group could never all join.
--
-- This migration makes TWO coordinated changes to the guest pay-first RPCs:
--
-- (A) book_guest_cyclus_for_payment — effective capacity = per-seat when split_payment OR
--     allow_single_booking (else whole-slot = 1). Only the v_max CASE changes; the advisory lock,
--     is_public guard, idempotent-hold reuse, occupancy predicate and insert are byte-identical to
--     20260704210000.
--
-- (B) book_guest_slot_for_payment — REFUSE a single-session hold on a CYCLUS session when the owner
--     did NOT enable allow_single_booking. Rationale: change (A) raises the CYCLUS capacity of a
--     split session to N, but the single-slot RPC's capacity stays keyed on allow_single_booking
--     (=1) and its CHARGE (computeSingleSlotPaymentAmount, allow_single_booking=false) is the FULL
--     session price. Without this guard a crafted call to the public create-guest-slot-payment
--     endpoint (verify_jwt=false, bypassing the UI) could plant a full-price single hold on the
--     now-N-capacity split session, over-collecting (e.g. €175 on a €100 session) — a regression the
--     capacity change would otherwise introduce. Single-session booking of a cyclus session is only
--     meaningful when allow_single_booking=true; otherwise the session must go through the whole-
--     cyclus path. This mirrors GuestBookingDialog (which hides the single option) at the mutation
--     boundary — the single place a guest seat is inserted — exactly like the is_public guard did.
--     Standalone (non-cyclus) slots are unaffected (cyclus_id IS NULL → guard never fires), so the
--     "book the whole standalone slot for full price" case still works.
--
-- The single-slot RPCs are deliberately NOT made split-aware for CAPACITY: doing so would let N
-- guests each pay the FULL price for one session. The read-side (publicAvailability.ts) and
-- GuestBookingDialog are updated in the same PR so the slot shows N spots and single-session booking
-- is not offered when allow_single_booking=false.

-- (A) Guest WHOLE-CYCLUS pay-first: split-aware capacity.
-- Byte-identical to 20260704210000 except the v_max CASE.
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

    -- Effective capacity (per-seat when split_payment OR allow_single_booking; else whole-slot = 1)
    -- + is_public in one read; refuse a non-public session.
    SELECT
      CASE WHEN COALESCE(split_payment, false) OR COALESCE(allow_single_booking, false)
           THEN COALESCE(max_participants, 1) ELSE 1 END,
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

-- (B) Guest single-slot pay-first: refuse single-booking of a cyclus session when the owner did not
-- enable individual-session booking. Byte-identical to 20260704210000 except: v_cyclus_id /
-- v_allow_single are read in the same capacity SELECT, and a single_booking_not_allowed guard runs
-- right after the is_public guard.
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

  -- Effective capacity (whole-slot = 1) + is_public + the cyclus/allow_single flags in one read.
  SELECT
    CASE WHEN COALESCE(allow_single_booking, false) THEN COALESCE(max_participants, 1) ELSE 1 END,
    COALESCE(is_public, false),
    cyclus_id,
    COALESCE(allow_single_booking, false)
    INTO v_max, v_is_public, v_cyclus_id, v_allow_single FROM public.availability_slots WHERE id = _slot_id;
  IF NOT v_is_public THEN
    RAISE EXCEPTION 'slot_not_public' USING ERRCODE = 'check_violation';
  END IF;

  -- A single session of a CYCLUS may only be booked on its own when the owner enabled
  -- allow_single_booking. Otherwise (incl. every split_payment session, which is per-seat and priced
  -- total÷N via book_guest_cyclus_for_payment) it must be booked via the whole-cyclus path — never as
  -- a FULL-price single hold, which would over-collect on the now-N-capacity split session.
  IF v_cyclus_id IS NOT NULL AND NOT v_allow_single THEN
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

REVOKE ALL ON FUNCTION public.book_guest_cyclus_for_payment(uuid, uuid[], numeric[], integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_guest_cyclus_for_payment(uuid, uuid[], numeric[], integer, text) TO service_role;
REVOKE ALL ON FUNCTION public.book_guest_slot_for_payment(uuid, uuid, numeric, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_guest_slot_for_payment(uuid, uuid, numeric, integer, text) TO service_role;
