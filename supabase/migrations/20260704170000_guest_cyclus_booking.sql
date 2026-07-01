-- Guest whole-cyclus PAY-FIRST: atomically hold a seat on EVERY future session of a
-- cyclus for one guest, so they can pay for the whole series upfront and only get
-- booked once the webhook commits.
--
-- book_guest_cyclus_for_payment mirrors book_guest_slot_for_payment's advisory-lock +
-- capacity predicate PER SLOT, but does it for N slots in ONE transaction: either all
-- N holds are created or none are (a full session RAISEs slot_full → the whole txn
-- rolls back, so the guest is never charged for a partial series). Locks are taken in
-- sorted slot-id order so two concurrent cyclus bookings on overlapping slots can't
-- deadlock. Idempotent: a re-click that already has live holds on every slot returns
-- those (no second set of holds / payment). Per-slot payment_amount is passed in
-- (the edge fn distributes the server-computed cyclus total across the sessions), so
-- sum(payment_amount) over the returned bookings equals the Mollie charge.
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

    SELECT max_participants INTO v_max FROM public.availability_slots WHERE id = v_slot;

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

REVOKE ALL ON FUNCTION public.book_guest_cyclus_for_payment(uuid, uuid[], numeric[], integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_guest_cyclus_for_payment(uuid, uuid[], numeric[], integer, text) TO service_role;
