-- ============================================================================
-- REBOOK · Second-bucket access = original cohort + registered priority list
-- ============================================================================
-- The member window ("second bucket": freed rebook seats open before the public)
-- was gated on is_cycle_member(auth.uid(), source_cycle_id) = "has a booking in
-- the new round" = REBOOKERS ONLY. That excludes the original cohort who did NOT
-- rebook (they let their slot go) and any promised priority-list players — exactly
-- the people the owner wants in the second bucket.
--
-- This migration widens ONLY the member-tier authorization. It is:
--   * ADDITIVE / NON-NARROWING — the new grant only ever returns MORE people true;
--     it can never block a current rebooker (clause 1 is unchanged is_cycle_member).
--   * CAPACITY-SAFE — membership is a pure authorization gate; capacity is counted
--     by booking status (slot_full) BEFORE and INDEPENDENT of the member check, so
--     a member-eligible booker still hits slot_full on a full slot.
--   * Leaves is_cycle_member untouched (keeps its literal "has a booking" meaning
--     for its client wrapper) and touches no capacity function.
-- ============================================================================

-- (1) The broadened second-bucket eligibility. TRUE when the caller is:
--   (a) an existing rebooker (unchanged is_cycle_member), OR
--   (b) anyone in the round's ORIGINAL COHORT — has ANY priority claim on a slot
--       whose source_cycle_id = _cycle_id (rebookers have 'claimed', non-rebookers
--       'declined'/'expired'; both have a row), OR
--   (c) on the REGISTERED priority list: their profile id is an element of
--       cycles.settings->'rebook_priority_people' (a jsonb string[] of profile ids;
--       guests never match — they have no auth.uid()/profile).
CREATE OR REPLACE FUNCTION public.can_book_member_window(_user_id uuid, _cycle_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (SELECT id FROM public.profiles WHERE user_id = _user_id LIMIT 1)
  SELECT
    -- (a) existing rebooker
    public.is_cycle_member(_user_id, _cycle_id)
    -- (b) original cohort: any priority claim on a slot in this round
    OR EXISTS (
      SELECT 1
      FROM public.slot_priority_claims spc
      JOIN public.availability_slots s ON s.id = spc.slot_id
      WHERE s.source_cycle_id = _cycle_id
        AND spc.player_id = (SELECT id FROM me)
    )
    -- (c) registered priority list stored on the cycle's settings
    OR EXISTS (
      SELECT 1
      FROM public.cycles c
      WHERE c.id = _cycle_id
        AND COALESCE(c.settings->'rebook_priority_people', '[]'::jsonb) ? (SELECT id::text FROM me)
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_book_member_window(uuid, uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.can_book_member_window(uuid, uuid) IS
  'Second-bucket (member window) booking eligibility: existing rebooker OR original cohort (any priority claim on a slot in this round) OR registered priority list (cycles.settings.rebook_priority_people). Pure authorization gate — never affects capacity.';

-- (2) enforce_booking_slot_tier — reproduced VERBATIM from 20260703140000 (the live
--     definition), with the SINGLE change that the member branch now calls
--     can_book_member_window instead of is_cycle_member. Nothing else changes.
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
    -- WIDENED: original cohort + registered priority list may also book, not just rebookers.
    v_is_member := public.can_book_member_window(auth.uid(), v_slot.source_cycle_id);
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
