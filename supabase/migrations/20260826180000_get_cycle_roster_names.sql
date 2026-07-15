-- Cycle-detail roster fix: registered (profile-keyed) players silently vanish from an academy's
-- cycle-detail roster.
--
-- getCycleDetail (src/lib/cycleDetail.ts) resolves participant names CLIENT-SIDE with the caller's
-- own JWT: guest names from guest_players (which academy managers CAN read) and registered-player
-- names from profiles (which they CANNOT — there is no "academy manager can view a player's
-- profile" RLS policy, only "…their trainers"). When the name comes back empty, the roster builder
-- drops the entry (`if (name && key && ref)`). So any player who booked/rebooked as a logged-in
-- account (a player_id booking, no guest row) is invisible in the academy cycle detail — even
-- though the cycle LIST (a SECURITY DEFINER RPC that bypasses RLS) shows them fine. Because the
-- roster drives remove/swap, a hidden participant also can't be managed.
--
-- Fix: resolve every participant's name through this SECURITY DEFINER RPC (bypasses RLS, one
-- authoritative source for BOTH profile and guest names) instead of the RLS-gated client reads.
-- Authorized to anyone who can already see the cycle's bookings: admin, an academy manager of a
-- slot's academy, a trainer who owns a slot, or a club manager of a club-owned cycle. Returns only
-- names of people already booked on the cycle's slots — no new disclosure.
CREATE OR REPLACE FUNCTION public.get_cycle_roster_names(_cycle_id uuid)
RETURNS TABLE (id uuid, full_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_type text;
  v_owner_id uuid;
BEGIN
  SELECT c.owner_type, c.owner_id INTO v_owner_type, v_owner_id
  FROM public.cycles c WHERE c.id = _cycle_id;

  -- Authorize: mirror who can already read this cycle's bookings (bookings/slots RLS) + admin.
  IF NOT (
    public.is_admin(auth.uid())
    OR (v_owner_type = 'club' AND v_owner_id IN (SELECT public.get_user_club_ids(auth.uid())))
    OR EXISTS (
      SELECT 1 FROM public.availability_slots s
      WHERE s.cyclus_id = _cycle_id AND (
        (s.academy_profile_id IS NOT NULL
          AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid())))
        OR s.trainer_id IN (SELECT tp.id FROM public.trainer_profiles tp WHERE tp.user_id = auth.uid())
      )
    )
  ) THEN
    RAISE EXCEPTION 'not_authorized_for_cycle' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  -- Registered players, keyed by profile id (the ids RLS blocks the manager from naming client-side).
  SELECT DISTINCT p.id, p.full_name
  FROM public.bookings b
  JOIN public.availability_slots s ON s.id = b.slot_id
  JOIN public.profiles p ON p.id = b.player_id
  WHERE s.cyclus_id = _cycle_id AND b.player_id IS NOT NULL AND p.full_name IS NOT NULL
  UNION
  -- Guests, keyed by guest id.
  SELECT DISTINCT g.id, g.full_name
  FROM public.bookings b
  JOIN public.availability_slots s ON s.id = b.slot_id
  JOIN public.guest_players g ON g.id = b.guest_player_id
  WHERE s.cyclus_id = _cycle_id AND b.guest_player_id IS NOT NULL AND g.full_name IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.get_cycle_roster_names(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cycle_roster_names(uuid) TO authenticated;
