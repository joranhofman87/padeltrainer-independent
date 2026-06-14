-- Phase 1 (scale audit) RC-001 + RC-003: the booking-capacity guards in both
-- enforce_booking_slot_tier (player self-booking) and respond_to_priority_claim
-- (priority-claim accept) count active bookings with a plain, unlocked
-- SELECT count(*). Under READ COMMITTED, concurrent callers each read the same
-- pre-insert count, all pass `< max_participants`, and all insert → the slot is
-- overbooked (which then mis-splits the cycle bill across the inflated roster).
-- The M-17 unique indexes only stop the SAME player double-booking, not DIFFERENT
-- players racing the last seat.
--
-- Fix: take a per-slot transaction advisory lock before the count, so same-slot
-- inserts serialize and each sees the prior committed row. Both functions use
-- the SAME key — hashtextextended(slot_id::text, 0) — so a self-booking and a
-- claim-accept on one slot also serialize against each other. The lock is
-- transaction-scoped (auto-released) and per-slot (no cross-slot contention);
-- re-acquiring the same key within one transaction is a no-op (the claim RPC
-- holds it, then its INSERT fires the trigger which re-acquires harmlessly).

-- (1) enforce_booking_slot_tier — add the lock before the capacity count.
CREATE OR REPLACE FUNCTION public.enforce_booking_slot_tier()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_profile uuid;
  v_slot           public.availability_slots;
  v_seats_taken    integer;
  v_has_pending    boolean;
  v_holds_claim    boolean;
  v_is_member      boolean;
  v_tier           text;
BEGIN
  v_caller_profile := public.get_profile_id_for_user(auth.uid());
  IF v_caller_profile IS NULL
     OR NEW.player_id IS NULL
     OR NEW.player_id <> v_caller_profile THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.slot_id IS NOT DISTINCT FROM OLD.slot_id
     AND NOT (COALESCE(OLD.status, 'confirmed') IN ('cancelled', 'cancelled_swap')
              AND COALESCE(NEW.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_slot FROM public.availability_slots WHERE id = NEW.slot_id;
  IF v_slot.id IS NULL THEN
    RETURN NEW; -- let the FK constraint handle a bad slot_id
  END IF;

  -- Serialize concurrent bookings for THIS slot so the count-then-check below is
  -- atomic (no overbooking race).
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.slot_id::text, 0));

  SELECT count(*) INTO v_seats_taken
  FROM public.bookings
  WHERE slot_id = NEW.slot_id
    AND id <> NEW.id
    AND COALESCE(status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap');

  IF v_seats_taken >= COALESCE(v_slot.max_participants, 1) THEN
    RAISE EXCEPTION 'slot_full' USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.slot_priority_claims
    WHERE slot_id = NEW.slot_id AND status = 'pending'
  ) INTO v_has_pending;

  IF v_slot.priority_window_ends_at IS NOT NULL
     AND v_slot.priority_window_ends_at > now()
     AND v_has_pending THEN
    v_tier := 'priority';
  ELSIF v_slot.member_window_ends_at IS NOT NULL
        AND v_slot.member_window_ends_at > now() THEN
    v_tier := 'members';
  ELSIF v_slot.public_release_status IN ('held', 'pending_admin_review') THEN
    v_tier := 'hidden';
  ELSE
    v_tier := 'public';
  END IF;

  IF v_tier = 'priority' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.slot_priority_claims
      WHERE slot_id = NEW.slot_id
        AND player_id = NEW.player_id
        AND status <> 'declined'
    ) INTO v_holds_claim;
    IF NOT v_holds_claim THEN
      RAISE EXCEPTION 'priority_restricted' USING ERRCODE = 'check_violation';
    END IF;

  ELSIF v_tier = 'members' THEN
    v_is_member := public.is_cycle_member(auth.uid(), v_slot.source_cycle_id);
    IF NOT COALESCE(v_is_member, false) THEN
      RAISE EXCEPTION 'members_only' USING ERRCODE = 'check_violation';
    END IF;

  ELSIF v_tier = 'hidden' THEN
    RAISE EXCEPTION 'slot_not_released' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_booking_slot_tier ON public.bookings;
CREATE TRIGGER trg_enforce_booking_slot_tier
  BEFORE INSERT OR UPDATE ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_booking_slot_tier();

-- (2) respond_to_priority_claim — lock the slot before each capacity count.
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

    -- Serialize concurrent accepts on this slot before counting seats.
    PERFORM pg_advisory_xact_lock(hashtextextended(c.slot_id::text, 0));

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
    -- Serialize concurrent accepts on this slot before counting seats.
    PERFORM pg_advisory_xact_lock(hashtextextended(rec.slot_id::text, 0));

    SELECT count(*) INTO v_seats_taken
    FROM public.bookings
    WHERE slot_id = rec.slot_id
      AND COALESCE(status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap');
    IF v_seats_taken >= COALESCE(rec.max_participants, 1) THEN
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
