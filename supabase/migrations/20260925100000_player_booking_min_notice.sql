-- Player self-booking minimum notice ("booking cutoff").
--
-- Some academies and trainers need to stop players booking too close to the start — e.g. no
-- self-bookings inside 48 hours — while staff can still add someone last minute.
--
-- RULE
--   effective cutoff = max(academy setting, trainer setting), NULLs treated as 0.
--   Default 0 everywhere, so behaviour is unchanged until somebody sets one.
--   The strictest wins: a trainer can TIGHTEN their academy's rule, never loosen it.
--   Applies to PLAYER/PUBLIC SELF-booking only. Staff booking on someone's behalf is exempt.
--
-- WHERE IT IS ENFORCED — deliberately NOT a new trigger.
--   public.can_book_slot(slot, user) is already the single source of truth for "may this player
--   self-book this slot", and it already has three callers covering every registered-player
--   route into public.bookings:
--     * trg_enforce_booking_slot_tier — the authenticated player self-insert path. It ALREADY
--       isolates that case (`NEW.player_id <> caller's profile` returns early), which is
--       exactly the staff exemption we need; a second trigger would have to re-derive that
--       test and could drift from it.
--     * book_slot_for_payment — the service_role RPC, which calls can_book_slot itself
--       precisely because the trigger skips when auth.uid() IS NULL.
--     * create-mollie-payment — the edge pre-check, before a payment is minted.
--   So one new reason token reaches all three, and the cutoff is refused at BOOKING CREATION
--   rather than at payment completion.
--
--   GUESTS are the one gap: book_guest_*_for_payment take no user id, so they never call
--   can_book_slot. Those three edge functions call is_slot_within_player_booking_cutoff()
--   directly before minting a payment.
--
-- TIME SOURCE is the database. availability_slots.start_time is timestamptz, so
-- `start_time - now()` is an absolute interval — no AT TIME ZONE, which would only introduce a
-- DST bug for a rule expressed as a duration rather than a wall clock. Browser time is
-- advisory: the UI hides late slots for usability, the DB decides.

-- ---------------------------------------------------------------------------
-- 1. The settings. 0 = no cutoff (current behaviour). Upper bound 7 days: beyond that a
--    "minimum notice" is really a different product (a registration deadline), and an
--    accidental extra zero would silently close a trainer's whole calendar.
ALTER TABLE public.academy_profiles
  ADD COLUMN IF NOT EXISTS player_booking_min_notice_minutes integer NOT NULL DEFAULT 0;
ALTER TABLE public.trainer_profiles
  ADD COLUMN IF NOT EXISTS player_booking_min_notice_minutes integer NOT NULL DEFAULT 0;

ALTER TABLE public.academy_profiles
  DROP CONSTRAINT IF EXISTS chk_academy_player_booking_min_notice;
ALTER TABLE public.academy_profiles
  ADD CONSTRAINT chk_academy_player_booking_min_notice
  CHECK (player_booking_min_notice_minutes >= 0 AND player_booking_min_notice_minutes <= 10080);

ALTER TABLE public.trainer_profiles
  DROP CONSTRAINT IF EXISTS chk_trainer_player_booking_min_notice;
ALTER TABLE public.trainer_profiles
  ADD CONSTRAINT chk_trainer_player_booking_min_notice
  CHECK (player_booking_min_notice_minutes >= 0 AND player_booking_min_notice_minutes <= 10080);

COMMENT ON COLUMN public.academy_profiles.player_booking_min_notice_minutes IS
  'Booking cutoff: players cannot self-book a session starting less than this many minutes from now. 0 = no cutoff. Staff booking on a player''s behalf is exempt. Combined with the trainer''s own setting by taking the STRICTER of the two.';
COMMENT ON COLUMN public.trainer_profiles.player_booking_min_notice_minutes IS
  'Booking cutoff: players cannot self-book a session starting less than this many minutes from now. 0 = no cutoff. Combined with the academy''s setting by taking the STRICTER of the two, so this can only tighten an academy rule, never loosen it.';

-- ---------------------------------------------------------------------------
-- 2. Effective cutoff for a slot: the STRICTER of the two tenants.
--
-- A slot always has a trainer_id and may have an academy_profile_id. greatest() over
-- coalesce(...,0) means an absent academy contributes nothing rather than NULLing the result —
-- an independent trainer's slot therefore uses the trainer's own setting.
CREATE OR REPLACE FUNCTION public.get_slot_player_booking_min_notice_minutes(p_slot_id uuid)
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT greatest(
           coalesce(ap.player_booking_min_notice_minutes, 0),
           coalesce(tp.player_booking_min_notice_minutes, 0)
         )
  FROM public.availability_slots s
  LEFT JOIN public.academy_profiles ap ON ap.id = s.academy_profile_id
  LEFT JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
  WHERE s.id = p_slot_id;
$$;
COMMENT ON FUNCTION public.get_slot_player_booking_min_notice_minutes(uuid) IS
  'Booking cutoff in minutes for a slot: the STRICTER of the academy and trainer settings, NULLs treated as 0. NULL when the slot does not exist — callers coalesce. INTERNAL.';

-- ---------------------------------------------------------------------------
-- 3. Is this slot inside its cutoff right now?
--
-- FALSE when the effective cutoff is 0, which is why the default preserves today's behaviour
-- exactly: with no setting, this can never block anything.
CREATE OR REPLACE FUNCTION public.is_slot_within_player_booking_cutoff(p_slot_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.availability_slots s
    CROSS JOIN LATERAL (
      SELECT coalesce(public.get_slot_player_booking_min_notice_minutes(s.id), 0) AS mins
    ) n
    WHERE s.id = p_slot_id
      AND n.mins > 0
      AND s.start_time - now() < make_interval(mins => n.mins)
  );
$$;
COMMENT ON FUNCTION public.is_slot_within_player_booking_cutoff(uuid) IS
  'TRUE when a slot is inside its player booking cutoff and may no longer be SELF-booked. Uses the database clock, never client time. FALSE when the cutoff is 0. INTERNAL — staff paths must not consult it, they are exempt.';

-- LOCKDOWN. This project runs ALTER DEFAULT PRIVILEGES granting EXECUTE on new functions to
-- anon and authenticated, and a bare REVOKE FROM PUBLIC does NOT undo that (see
-- 20260715110000_restrict_slot_tier_helper_grants.sql, which was written after exactly this
-- leaked to an anon key). Both helpers answer questions about arbitrary slots, so they are
-- named-role revoked and service_role only — matching can_book_slot / resolve_slot_booking_tier.
REVOKE ALL ON FUNCTION public.get_slot_player_booking_min_notice_minutes(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_slot_player_booking_min_notice_minutes(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.is_slot_within_player_booking_cutoff(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_slot_within_player_booking_cutoff(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. The gate itself: one more reason token on can_book_slot.
--
-- Placed LAST, after the tier checks, so visibility still wins: a hidden slot reports
-- 'slot_not_released' rather than leaking that it exists but is merely too late. The cutoff is
-- an additional rule applied after visibility and capacity, not a replacement for either.
--
-- Body is otherwise byte-for-byte the deployed 20260715100000 definition; the signature is
-- unchanged, so no generated-types drift.
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

  -- Booking cutoff, last: the player may be eligible for this tier and still be too late.
  IF public.is_slot_within_player_booking_cutoff(_slot_id) THEN
    RETURN 'booking_cutoff';
  END IF;

  RETURN '';  -- 'public', or eligible for the current tier
END;
$$;
COMMENT ON FUNCTION public.can_book_slot(uuid, uuid) IS
  'Whether _user_id may book _slot_id right now: '''' = allowed, else priority_restricted|members_only|slot_not_released|booking_cutoff. Tier is checked before the cutoff, so a hidden slot never reveals itself as merely late. service_role only (takes arbitrary _user_id).';
