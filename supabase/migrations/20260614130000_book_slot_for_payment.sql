-- Phase 1 (scale audit) RC-001 (paid path): create-mollie-payment inserts a new
-- single booking with the service-role client, so enforce_booking_slot_tier
-- early-returns (auth.uid() is NULL) and the slot capacity is NEVER checked on
-- the paid path — a player can pay for a seat on an already-full slot.
--
-- book_slot_for_payment does the SAME locked capacity check the trigger and the
-- claim RPC use (same advisory-lock key, so all three serialize per slot), then
-- inserts the pending booking and returns its id. raises 'slot_full' when full
-- so the edge function can refuse before creating a Mollie payment.

CREATE OR REPLACE FUNCTION public.book_slot_for_payment(
  _slot_id uuid,
  _player_id uuid,
  _payment_amount numeric
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

  INSERT INTO public.bookings (slot_id, player_id, payment_status, status, payment_amount)
  VALUES (_slot_id, _player_id, 'pending', 'pending', _payment_amount)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.book_slot_for_payment(uuid, uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_slot_for_payment(uuid, uuid, numeric) TO service_role;
