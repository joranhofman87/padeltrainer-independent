-- Trainer-side audit P1: guests minted by the PUBLIC payment flows on academy slots are
-- owned by the ACADEMY (create-guest-slot/cyclus/cart-payment set academy_profile_id when
-- the slot has one), while trainer RLS on guest_players is own-rows only
-- ("Trainers can view their own guest players", 20260116200114). Result: a newcomer books
-- and PAYS via the academy's public page and the trainer standing on court sees the seat
-- as "Unknown" — no name, level, or contact anywhere in the app (slot detail, schedule
-- overview, agenda and calendar all resolve guest names via RLS-subject embeds).
--
-- Fix: trainers may read guests with an ACTIVE booking on one of their OWN slots.
-- SECURITY DEFINER predicate per the house pattern (guest_belongs_to_user_academy,
-- 20260706130100) so the policy doesn't recurse into bookings/availability_slots RLS.
-- Write policies and get_players_overview (trainer scope stays own-guests) are untouched.

CREATE OR REPLACE FUNCTION public.guest_booked_with_trainer(
  _guest_id uuid,
  _user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
    WHERE b.guest_player_id = _guest_id
      AND tp.user_id = _user_id
      -- The fn is EXECUTE-granted to all of `authenticated` (PostgREST rpc), so the
      -- caller-supplied _user_id must be pinned to the CALLER — otherwise it is a
      -- cross-tenant oracle ("does guest X train with trainer Y?") for anyone
      -- holding a guest UUID. The RLS policy always passes auth.uid() anyway.
      AND _user_id = auth.uid()
      -- Canonical inactive-booking predicate: cancelled / swapped-away seats
      -- grant no visibility.
      AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
  )
$$;

REVOKE ALL ON FUNCTION public.guest_booked_with_trainer(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guest_booked_with_trainer(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.guest_booked_with_trainer(uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS "Trainers can view guests booked into their slots" ON public.guest_players;
CREATE POLICY "Trainers can view guests booked into their slots"
ON public.guest_players FOR SELECT
TO authenticated
USING (public.guest_booked_with_trainer(id, auth.uid()));

-- Install assertions (no data mutation).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'guest_players'
      AND policyname = 'Trainers can view guests booked into their slots'
      AND cmd = 'SELECT'
      AND qual::text ILIKE '%guest_booked_with_trainer%'
  ) THEN
    RAISE EXCEPTION 'trainer booked-guest SELECT policy missing on guest_players';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'guest_booked_with_trainer'
      AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'guest_booked_with_trainer must be SECURITY DEFINER (RLS recursion)';
  END IF;
END $$;
