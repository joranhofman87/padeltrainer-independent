-- ============================================================================
-- Bulk cohort rebooking — group-level priority claims.
--
-- A rebooked group is a weekly SERIES (e.g. "Monday 18:00 with trainer X at
-- location Y" running N weeks). The cohort X-ray confirmed real groups are
-- multi-week (~12 sessions). The previous model created one claim — and one
-- invite email — per weekly slot, so a player would get N emails and one
-- "Yes" booked only a single week. This adds rebook_group_id to tie all of a
-- player's weekly claims for one series together, and makes
-- respond_to_priority_claim GROUP-AWARE: a single accept books EVERY pending
-- slot in the group (the whole next term), a single decline releases them all.
-- Legacy claims (rebook_group_id IS NULL) keep the original single-slot
-- behavior byte-for-byte.
-- ============================================================================

ALTER TABLE public.slot_priority_claims
  ADD COLUMN IF NOT EXISTS rebook_group_id uuid;

CREATE INDEX IF NOT EXISTS idx_slot_priority_claims_rebook_group
  ON public.slot_priority_claims(rebook_group_id)
  WHERE rebook_group_id IS NOT NULL;

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
  v_first_booking uuid;
  v_booked integer := 0;
  v_declined integer := 0;
  v_skipped_full integer := 0;
  rec record;
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

  -- ================= LEGACY single-claim path (rebook_group_id IS NULL) =====
  IF c.rebook_group_id IS NULL THEN
    IF _action = 'decline' THEN
      UPDATE public.slot_priority_claims
        SET status = 'declined', responded_at = now(), decline_reason = _reason
        WHERE id = c.id;
      RETURN jsonb_build_object('ok', true, 'status', 'declined');
    END IF;

    SELECT count(*) INTO v_seats_taken
    FROM public.bookings
    WHERE slot_id = c.slot_id
      AND COALESCE(status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap');
    IF v_seats_taken >= COALESCE(s.max_participants, 1) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'slot_full');
    END IF;

    INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status, payment_status, created_at, updated_at)
    VALUES (c.slot_id, c.player_id, c.guest_player_id, 'confirmed', 'pending', now(), now())
    RETURNING id INTO v_booking_id;

    UPDATE public.slot_priority_claims
      SET status = 'claimed', responded_at = now(), booking_id = v_booking_id
      WHERE id = c.id;

    RETURN jsonb_build_object('ok', true, 'status', 'claimed', 'booking_id', v_booking_id);
  END IF;

  -- ================= GROUP path (whole series in one click) ================
  -- Operate on every still-pending claim in this group for THIS claimant
  -- (the same player/guest), so one Yes books the whole next term and one No
  -- releases it. Other players' claims in the group are untouched.
  IF _action = 'decline' THEN
    FOR rec IN
      SELECT id FROM public.slot_priority_claims
      WHERE rebook_group_id = c.rebook_group_id
        AND status = 'pending'
        AND player_id IS NOT DISTINCT FROM c.player_id
        AND guest_player_id IS NOT DISTINCT FROM c.guest_player_id
      FOR UPDATE
    LOOP
      UPDATE public.slot_priority_claims
        SET status = 'declined', responded_at = now(), decline_reason = _reason
        WHERE id = rec.id;
      v_declined := v_declined + 1;
    END LOOP;
    RETURN jsonb_build_object('ok', true, 'status', 'declined', 'group', true, 'declined', v_declined);
  END IF;

  -- accept: book every pending slot in the group, capacity-guarding each.
  FOR rec IN
    SELECT spc.id, spc.slot_id, spc.player_id, spc.guest_player_id,
           av.max_participants
    FROM public.slot_priority_claims spc
    JOIN public.availability_slots av ON av.id = spc.slot_id
    WHERE spc.rebook_group_id = c.rebook_group_id
      AND spc.status = 'pending'
      AND spc.player_id IS NOT DISTINCT FROM c.player_id
      AND spc.guest_player_id IS NOT DISTINCT FROM c.guest_player_id
    ORDER BY av.start_time
    FOR UPDATE OF spc
  LOOP
    SELECT count(*) INTO v_seats_taken
    FROM public.bookings
    WHERE slot_id = rec.slot_id
      AND COALESCE(status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap');
    IF v_seats_taken >= COALESCE(rec.max_participants, 1) THEN
      -- Leave this claim pending (the owner can see it didn't fit); keep going.
      v_skipped_full := v_skipped_full + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status, payment_status, created_at, updated_at)
    VALUES (rec.slot_id, rec.player_id, rec.guest_player_id, 'confirmed', 'pending', now(), now())
    RETURNING id INTO v_booking_id;
    IF v_first_booking IS NULL THEN v_first_booking := v_booking_id; END IF;

    UPDATE public.slot_priority_claims
      SET status = 'claimed', responded_at = now(), booking_id = v_booking_id
      WHERE id = rec.id;
    v_booked := v_booked + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', v_booked > 0,
    'status', CASE WHEN v_booked > 0 THEN 'claimed' ELSE 'slot_full' END,
    'group', true,
    'booked', v_booked,
    'skipped_full', v_skipped_full,
    'booking_id', v_first_booking
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.respond_to_priority_claim(text, text, text) TO anon, authenticated;
