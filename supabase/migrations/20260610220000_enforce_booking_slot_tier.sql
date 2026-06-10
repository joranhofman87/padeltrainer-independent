-- ============================================================================
-- Phase 1 enforcement: gate player self-bookings by slot tier + capacity.
--
-- Verify after deploy with:
--   RUN_REBOOKING_ENFORCEMENT=1 SUPABASE_SERVICE_ROLE_KEY=... \
--   VITE_SUPABASE_URL=... VITE_SUPABASE_PUBLISHABLE_KEY=... \
--   npx playwright test tests/rebooking-enforcement.spec.ts
--
-- Why a trigger: bookings are inserted directly from the client and the
-- bookings INSERT RLS only checks `player_id = self`. It does NOT enforce the
-- priority/member window or slot capacity, so both can be bypassed by a crafted
-- insert. This BEFORE INSERT trigger enforces them server-side. The decision
-- logic mirrors supabase/functions/_shared/slot-tier.ts (unit-tested).
--
-- Scope: only PLAYER SELF-bookings (auth.uid() resolves to the booked player)
-- are gated. Trainer/academy/club-manager-created bookings, guest bookings
-- (player_id NULL) and service-role inserts bypass — they legitimately manage
-- the slot.
-- ============================================================================

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
  -- Only enforce for player self-bookings. Anyone else (trainer/manager via a
  -- different auth.uid(), guest bookings, service role) bypasses.
  v_caller_profile := public.get_profile_id_for_user(auth.uid());
  IF v_caller_profile IS NULL
     OR NEW.player_id IS NULL
     OR NEW.player_id <> v_caller_profile THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_slot FROM public.availability_slots WHERE id = NEW.slot_id;
  IF v_slot.id IS NULL THEN
    RETURN NEW; -- let the FK constraint handle a bad slot_id
  END IF;

  -- Capacity (overbooking guard) — count non-cancelled bookings already present.
  SELECT count(*) INTO v_seats_taken
  FROM public.bookings
  WHERE slot_id = NEW.slot_id
    AND COALESCE(status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap');

  IF v_seats_taken >= COALESCE(v_slot.max_participants, 1) THEN
    RAISE EXCEPTION 'slot_full' USING ERRCODE = 'check_violation';
  END IF;

  -- Resolve the slot tier (mirror of resolveSlotTier in slot-tier.ts).
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
  BEFORE INSERT ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_booking_slot_tier();
