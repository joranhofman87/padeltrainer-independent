-- ============================================================================
-- Phase 2 #1 — commitment capture: let a player ACCEPT a priority claim with a
-- single click (no upfront payment). Accepting creates a confirmed, UNPAID
-- "commitment" booking and marks the claim 'claimed'. The deferred cycle-start
-- invoicing job later invoices each committer cycle_total / N.
--
-- NOT YET DEPLOYED. Held in docs/pending-migrations/ (Supabase only applies
-- files in supabase/migrations/). To deploy: move into
--   supabase/migrations/<timestamp>_priority_claim_accept.sql  and apply.
--
-- This extends the existing respond_to_priority_claim(_token,_action,_reason)
-- RPC (anon + token based, so it works from a one-click email button AND from
-- the in-app banner) to support _action = 'accept' alongside 'decline'.
--
-- Notes on interaction with the booking-tier enforcement trigger
-- (docs/pending-migrations/enforce_booking_slot_tier.sql): for an anonymous
-- email click auth.uid() is NULL so that trigger bypasses; for an in-app
-- authenticated accept the player holds a still-pending claim, so the trigger's
-- priority-tier check passes. Capacity is checked here and there consistently.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.respond_to_priority_claim(_token text, _action text, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.slot_priority_claims;
  s public.availability_slots;
  v_seats_taken integer;
  v_booking_id uuid;
BEGIN
  IF _action NOT IN ('decline', 'accept') THEN
    RAISE EXCEPTION 'Unsupported action: %', _action;
  END IF;

  SELECT * INTO c FROM public.slot_priority_claims WHERE claim_token = _token FOR UPDATE;
  IF c.id IS NULL THEN
    RAISE EXCEPTION 'Claim not found';
  END IF;

  SELECT * INTO s FROM public.availability_slots WHERE id = c.slot_id;

  IF c.status NOT IN ('pending') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_responded', 'status', c.status);
  END IF;

  IF s.priority_window_ends_at IS NOT NULL AND s.priority_window_ends_at < now() THEN
    UPDATE public.slot_priority_claims
      SET status = 'expired', responded_at = now()
      WHERE id = c.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'window_expired');
  END IF;

  -- ---------------- decline (unchanged) ----------------
  IF _action = 'decline' THEN
    UPDATE public.slot_priority_claims
      SET status = 'declined',
          responded_at = now(),
          decline_reason = _reason
      WHERE id = c.id;
    RETURN jsonb_build_object('ok', true, 'status', 'declined');
  END IF;

  -- ---------------- accept (commit, no payment) ----------------
  -- Capacity guard (overbooking).
  SELECT count(*) INTO v_seats_taken
  FROM public.bookings
  WHERE slot_id = c.slot_id
    AND COALESCE(status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap');

  IF v_seats_taken >= COALESCE(s.max_participants, 1) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'slot_full');
  END IF;

  -- Create the commitment: a confirmed but UNPAID booking for the claimant.
  INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status, payment_status, created_at, updated_at)
  VALUES (c.slot_id, c.player_id, c.guest_player_id, 'confirmed', 'pending', now(), now())
  RETURNING id INTO v_booking_id;

  UPDATE public.slot_priority_claims
    SET status = 'claimed',
        responded_at = now(),
        booking_id = v_booking_id
    WHERE id = c.id;

  RETURN jsonb_build_object('ok', true, 'status', 'claimed', 'booking_id', v_booking_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.respond_to_priority_claim(text, text, text) TO anon, authenticated;
