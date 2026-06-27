-- Option A mutation boundary for public single-slot online booking
-- (Codex foundation-verification Finding 1): create-mollie-payment now OWNS the
-- booking insert for the online single-slot path (the page no longer inserts),
-- so the player's `notes` must travel through the edge function into
-- book_slot_for_payment. Extend the RPC with an optional `_notes` parameter.
--
-- The 4th parameter has a DEFAULT, so existing 3-arg callers (and the edge
-- function during the deploy gap, before it is redeployed) still resolve to this
-- function with notes = NULL. Drop the old 3-arg signature so only one remains.

DROP FUNCTION IF EXISTS public.book_slot_for_payment(uuid, uuid, numeric);

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
  -- Serialize concurrent bookings for this slot before counting (same key as
  -- enforce_booking_slot_tier / respond_to_priority_claim).
  PERFORM pg_advisory_xact_lock(hashtextextended(_slot_id::text, 0));

  SELECT max_participants INTO v_max FROM public.availability_slots WHERE id = _slot_id;

  SELECT count(*) INTO v_taken
  FROM public.bookings
  WHERE slot_id = _slot_id
    AND COALESCE(status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap');

  IF v_taken >= COALESCE(v_max, 1) THEN
    RAISE EXCEPTION 'slot_full' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.bookings (slot_id, player_id, payment_status, status, payment_amount, notes)
  VALUES (_slot_id, _player_id, 'pending', 'pending', _payment_amount, NULLIF(btrim(_notes), ''))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.book_slot_for_payment(uuid, uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_slot_for_payment(uuid, uuid, numeric, text) TO service_role;
