-- ============================================================================
-- REBOOK GO-LIVE · Workstream A, Slice A1 — strict pay-first HOLD foundation
-- ============================================================================
-- Opt-in (per cycle) "no seat until Mollie paid". A strict accept (A2) inserts a
-- short-lived HOLD instead of a confirmed booking: status='payment_pending' with
-- a TTL in bookings.hold_expires_at. The webhook (A4) commits the hold to
-- confirmed/paid on payment, or a cleanup cron (A2) releases it on expiry.
--
-- THIS SLICE is purely additive schema + capacity wiring, INERT until A2 starts
-- creating holds:
--   1. bookings.hold_expires_at (nullable) — the hold TTL.
--   2. widen bookings_status_check to allow 'payment_pending' (superset of every
--      status the codebase already uses — never narrows the allowed set).
--   3. teach all FIVE slot-capacity counts to count an ACTIVE hold as occupying:
--        ... OR (status = 'payment_pending' AND hold_expires_at > now())
--      so a hold blocks others from taking the seat, and an EXPIRED hold frees it
--      in real time (capacity self-heals; the cron is just bookkeeping).
--
-- ADDITIVE / NON-STRICT BYTE-IDENTICAL: no row has status='payment_pending' today
-- and only A2's strict RPC (gated on cycles.settings.rebook_strict_mollie) ever
-- creates one, so the new clause matches nothing for existing data and every
-- non-strict cycle — these five functions behave exactly as 20260702140000. The
-- five bodies are reproduced verbatim from 20260702140000; ONLY the count
-- predicate changes. Counts stay under the existing per-slot advisory lock
-- pg_advisory_xact_lock(hashtextextended(slot_id,0)) → no overbooking.
-- ============================================================================

-- (0) Schema: the hold TTL column + widened status domain.
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS hold_expires_at timestamptz;

COMMENT ON COLUMN public.bookings.hold_expires_at IS
  'Strict rebook (A1): TTL for a status=payment_pending hold. Seat is held only while > now(); the webhook commits or the release cron cancels it. NULL for every non-hold booking.';

ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN (
    'pending', 'pending_approval', 'confirmed', 'cancelled', 'cancelled_swap',
    'completed', 'rejected', 'payment_pending'
  ));

-- (1) enforce_booking_slot_tier — staff/self capacity guard (BEFORE INSERT OR UPDATE).
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
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  v_caller_profile := public.get_profile_id_for_user(auth.uid());

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

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.slot_id::text, 0));

  SELECT count(*) INTO v_seats_taken
  FROM public.bookings
  WHERE slot_id = NEW.slot_id
    AND id <> NEW.id
    AND (
      COALESCE(status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
      OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now())
    );

  IF v_seats_taken >= COALESCE(v_slot.max_participants, 1) THEN
    RAISE EXCEPTION 'slot_full' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.player_id IS NULL OR NEW.player_id <> v_caller_profile THEN
    RETURN NEW;
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

-- (2) book_slot_for_payment — capacity-locked online-payment booking insert.
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

  SELECT max_participants INTO v_max FROM public.availability_slots WHERE id = _slot_id;

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

REVOKE ALL ON FUNCTION public.book_slot_for_payment(uuid, uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_slot_for_payment(uuid, uuid, numeric, text) TO service_role;

-- (3) respond_to_priority_claim — both capacity counts (legacy single + group accept).
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
      AND (
        COALESCE(status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
        OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now())
      );
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
      AND (
        COALESCE(status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
        OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now())
      );
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

-- (4) swap_member_booking — member self-swap to another slot (target-slot capacity count).
CREATE OR REPLACE FUNCTION public.swap_member_booking(_old_booking_id uuid, _new_slot_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_booking bookings;
  v_new_slot availability_slots;
  v_user_profile_id uuid;
  v_new_booking_id uuid;
BEGIN
  -- Resolve caller profile
  SELECT id INTO v_user_profile_id FROM profiles WHERE user_id = auth.uid() LIMIT 1;
  IF v_user_profile_id IS NULL THEN
    RAISE EXCEPTION 'No profile for caller';
  END IF;

  SELECT * INTO v_old_booking FROM bookings WHERE id = _old_booking_id FOR UPDATE;
  IF v_old_booking.id IS NULL OR v_old_booking.player_id IS DISTINCT FROM v_user_profile_id THEN
    RAISE EXCEPTION 'Booking not found or not yours';
  END IF;

  SELECT * INTO v_new_slot FROM availability_slots WHERE id = _new_slot_id FOR UPDATE;
  IF v_new_slot.id IS NULL THEN
    RAISE EXCEPTION 'Slot not found';
  END IF;

  -- Capacity check
  IF (SELECT COUNT(*) FROM bookings WHERE slot_id = _new_slot_id AND (
        COALESCE(status,'confirmed') IN ('confirmed','pending','pending_approval')
        OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now())
      )) >= COALESCE(v_new_slot.max_participants, 1) THEN
    RAISE EXCEPTION 'Slot is full';
  END IF;

  UPDATE bookings SET status = 'cancelled_swap', updated_at = now() WHERE id = _old_booking_id;

  INSERT INTO bookings (slot_id, player_id, status, created_at, updated_at)
  VALUES (_new_slot_id, v_user_profile_id, 'confirmed', now(), now())
  RETURNING id INTO v_new_booking_id;

  RETURN jsonb_build_object('ok', true, 'new_booking_id', v_new_booking_id);
END;
$$;
