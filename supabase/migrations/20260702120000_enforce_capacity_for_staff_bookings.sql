-- A1 (foundation hardening): the slot-capacity overbooking guard was enforced
-- ONLY for player self-bookings. enforce_booking_slot_tier early-returned for
-- staff-created bookings, guest bookings (player_id NULL) AND service-role
-- inserts (the single `v_caller_profile IS NULL OR player_id IS NULL OR
-- player_id <> caller` bypass). So a trainer/academy adding a player or guest,
-- or the cycle-add path, could overbook a slot past max_participants — and then
-- mis-split the cycle bill across the inflated roster. The booking dialogs cap
-- the UI at capacity, but nothing enforced it server-side for these paths, and
-- two concurrent staff inserts could still race the last seat.
--
-- Fix: run the advisory-locked CAPACITY check for ALL *authenticated* inserts
-- (player self, staff-for-player, staff-for-guest), while the TIER checks
-- (priority / member / hidden booking windows) stay player-self-only — staff and
-- guests legitimately manage the slot and aren't subject to the booking-window
-- tiers. Service-role inserts (auth.uid() IS NULL) STILL bypass: those backend
-- paths run the SAME advisory-locked capacity guard themselves
-- (book_slot_for_payment, respond_to_priority_claim) and the batch flows insert
-- onto freshly-created empty slots — enforcing here would be redundant at best
-- and could break a legitimate backend insert, so this slice keeps the
-- blast radius to the authenticated UI paths that were the actual gap.
--
-- Only the FUNCTION body changes; the trigger (BEFORE INSERT OR UPDATE) is
-- unchanged. The advisory-lock key + capacity count are identical to the prior
-- self-booking path, so the existing self-booking behaviour is preserved exactly.

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
  -- Service-role / unauthenticated inserts bypass — those backend paths
  -- (book_slot_for_payment, respond_to_priority_claim) self-guard capacity with
  -- the same advisory lock, and batch flows insert onto fresh empty slots.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  v_caller_profile := public.get_profile_id_for_user(auth.uid());

  -- UPDATE short-circuit: only re-check when the row moves to another slot or
  -- un-cancels into an occupying status. A benign payment/notes update is a
  -- no-op (and cancelling a booking never needs a capacity re-check).
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

  -- CAPACITY (overbooking guard) — enforced for EVERY authenticated insert now,
  -- including staff-created and guest bookings (previously bypassed). The
  -- advisory lock serializes same-slot writes so the count-then-check is atomic
  -- (same key as book_slot_for_payment / respond_to_priority_claim).
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.slot_id::text, 0));

  SELECT count(*) INTO v_seats_taken
  FROM public.bookings
  WHERE slot_id = NEW.slot_id
    AND id <> NEW.id
    AND COALESCE(status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap');

  IF v_seats_taken >= COALESCE(v_slot.max_participants, 1) THEN
    RAISE EXCEPTION 'slot_full' USING ERRCODE = 'check_violation';
  END IF;

  -- TIER checks (priority / member / hidden booking windows) apply ONLY to a
  -- player booking THEMSELVES. Staff- and guest-created bookings legitimately
  -- bypass the windows — the slot owner is placing them.
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
