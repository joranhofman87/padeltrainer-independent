-- ============================================================================
-- REBOOK · Single-source slot-tier resolution + authenticated-payment tier gate
-- ============================================================================
-- Closes two confirmed tier-enforcement holes in the rebooking windows:
--
--   RB01 (P0): the authenticated single-slot pay-first path
--     (create-mollie-payment → book_slot_for_payment) inserts the booking as
--     service_role, so enforce_booking_slot_tier early-returns (auth.uid() IS
--     NULL) and NO tier check runs. A logged-in player could book a
--     priority/member-hidden slot, holding a seat away from legitimate
--     claimants. book_slot_for_payment only checked CAPACITY.
--
--   RB02 (P1): the trigger's priority branch counted only status='pending'
--     (ignoring 'claimed'), and the member branch gated on member_window_ends_at
--     without member_window_starts_at — so a claimed+declined, zero-pending slot
--     fell through to the members tier DURING the priority window, letting a
--     cohort member book a freed seat early while the client still hid it.
--
-- Fix: ONE canonical source of truth — resolve_slot_booking_tier + can_book_slot —
-- consulted by the trigger (self-booking path), book_slot_for_payment (the
-- service-role hard boundary), and the create-mollie-payment edge pre-check.
-- Capacity stays a SEPARATE inline concern (unchanged) in both the trigger and
-- the RPC. Guest RPCs (book_guest_slot_for_payment / book_guest_cyclus_for_payment)
-- and swap_member_booking are intentionally untouched.
--
-- Depends on: 20260714100000 (can_book_member_window), 20260704190000
-- (book_slot_for_payment body re-emitted here), plus get_profile_id_for_user.
-- ============================================================================

-- (1) Pure tier resolution — the RB02-correct predicate, single source of truth.
--   * priority: window still open AND a claim is still live (pending OR CLAIMED) —
--     mirrors the client (computeReleasedSlotIds treats pending|claimed as holding).
--   * members: member window has STARTED (starts_at <= now, NULL ⇒ legacy "already
--     started") AND not yet ended. The starts_at gate closes the RB02 fall-through.
--   * priority_window_starts_at is intentionally NOT gated: priority tier is defined
--     by claim-presence + ends_at (a claim only exists once the window opens), and the
--     client defines it the same way — adding a server-only starts_at gate would
--     disagree with the client in the unsafe (permissive) direction.
CREATE OR REPLACE FUNCTION public.resolve_slot_booking_tier(_slot_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH s AS (
    SELECT * FROM public.availability_slots WHERE id = _slot_id
  ),
  held AS (
    SELECT EXISTS (
      SELECT 1 FROM public.slot_priority_claims
      WHERE slot_id = _slot_id AND status IN ('pending', 'claimed')
    ) AS any_hold
  )
  SELECT CASE
    WHEN s.priority_window_ends_at IS NOT NULL
         AND s.priority_window_ends_at > now()
         AND held.any_hold
      THEN 'priority'
    WHEN s.member_window_ends_at IS NOT NULL
         AND s.member_window_ends_at > now()
         AND (s.member_window_starts_at IS NULL OR s.member_window_starts_at <= now())
      THEN 'members'
    WHEN s.public_release_status IN ('held', 'pending_admin_review')
      THEN 'hidden'
    ELSE 'public'
  END
  FROM s, held;
$$;

-- (2) Eligibility of a specific user for a slot's current tier.
--   Returns '' when allowed; otherwise the refusal reason (same strings the trigger
--   has always raised, so clients/tests that match on them keep working).
--   Priority requires the caller to hold a LIVE claim (pending|claimed) — NOT merely
--   "not declined", so an expired/declined claim can't authorize a booking while
--   another live claim keeps the slot in the priority tier.
CREATE OR REPLACE FUNCTION public.can_book_slot(_slot_id uuid, _user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tier    text := public.resolve_slot_booking_tier(_slot_id);
  v_profile uuid := public.get_profile_id_for_user(_user_id);
  v_src     uuid;
BEGIN
  IF v_tier = 'priority' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.slot_priority_claims
      WHERE slot_id = _slot_id
        AND player_id = v_profile
        AND status IN ('pending', 'claimed')
    ) THEN
      RETURN 'priority_restricted';
    END IF;

  ELSIF v_tier = 'members' THEN
    SELECT source_cycle_id INTO v_src FROM public.availability_slots WHERE id = _slot_id;
    IF NOT COALESCE(public.can_book_member_window(_user_id, v_src), false) THEN
      RETURN 'members_only';
    END IF;

  ELSIF v_tier = 'hidden' THEN
    RETURN 'slot_not_released';
  END IF;

  RETURN '';  -- 'public', or eligible for the current tier
END;
$$;

-- (3) enforce_booking_slot_tier — rebased VERBATIM on 20260714100000, with the ONLY
--     change that the self-booking tier branch (priority/members/hidden resolution +
--     eligibility) now delegates to can_book_slot. The auth.uid()/service early-return,
--     the UPDATE skip, the advisory lock + inline capacity check, the manager-on-behalf
--     early-return, and SECURITY DEFINER / search_path are byte-for-byte unchanged.
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
  v_reason         text;
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

  -- Self-booking tier gate — single source of truth (RB02 corrections live inside).
  v_reason := public.can_book_slot(NEW.slot_id, auth.uid());
  IF v_reason <> '' THEN
    RAISE EXCEPTION USING MESSAGE = v_reason, ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_booking_slot_tier ON public.bookings;
CREATE TRIGGER trg_enforce_booking_slot_tier
  BEFORE INSERT OR UPDATE ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_booking_slot_tier();

-- (4) book_slot_for_payment — re-emitted from 20260704190000 (whole-slot capacity),
--     adding the tier gate as the HARD boundary for the authenticated pay-first path.
--     The advisory lock, effective-capacity derivation, occupancy predicate and INSERT
--     are byte-for-byte unchanged. This RPC is for AUTHENTICATED PLAYERS only: resolve
--     the caller's auth user from the profile and refuse a profile with no linked user
--     (player_not_linked) rather than skipping the gate.
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
  v_max    integer;
  v_taken  integer;
  v_uid    uuid;
  v_reason text;
  v_id     uuid;
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

  -- RB01: service_role runs this, so the enforce_booking_slot_tier trigger skips
  -- (auth.uid() IS NULL). Enforce the tier HERE. Authenticated-players only —
  -- a profile with no linked auth user must not slip past the gate.
  SELECT user_id INTO v_uid FROM public.profiles WHERE id = _player_id;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'player_not_linked' USING ERRCODE = 'check_violation';
  END IF;
  v_reason := public.can_book_slot(_slot_id, v_uid);
  IF v_reason <> '' THEN
    RAISE EXCEPTION USING MESSAGE = v_reason, ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.bookings (slot_id, player_id, payment_status, status, payment_amount, notes)
  VALUES (_slot_id, _player_id, 'pending', 'pending', _payment_amount, NULLIF(btrim(_notes), ''))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Grants ---------------------------------------------------------------------
-- book_slot_for_payment: unchanged (service_role only).
REVOKE ALL ON FUNCTION public.book_slot_for_payment(uuid, uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_slot_for_payment(uuid, uuid, numeric, text) TO service_role;

-- resolve_slot_booking_tier / can_book_slot: service_role ONLY. They take an arbitrary
-- _user_id, so exposing them to anon/authenticated would leak whether any user has
-- claim/member access to any slot. The trigger + book_slot_for_payment call them via
-- SECURITY DEFINER ownership; the edge pre-check calls can_book_slot as service_role.
-- If the frontend ever needs this, add a separate can_current_user_book_slot(_slot_id)
-- wrapper that uses auth.uid() internally (no arbitrary-user arg).
REVOKE ALL ON FUNCTION public.resolve_slot_booking_tier(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_slot_booking_tier(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.can_book_slot(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_book_slot(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.resolve_slot_booking_tier(uuid) IS
  'Canonical slot booking tier (priority|members|hidden|public). RB02-correct: priority counts pending|claimed; members gates on member_window_starts_at. Single source of truth for the trigger, book_slot_for_payment, and the create-mollie-payment pre-check.';
COMMENT ON FUNCTION public.can_book_slot(uuid, uuid) IS
  'Whether _user_id may book _slot_id at its current tier: '''' = allowed, else priority_restricted|members_only|slot_not_released. service_role only (takes arbitrary _user_id).';
