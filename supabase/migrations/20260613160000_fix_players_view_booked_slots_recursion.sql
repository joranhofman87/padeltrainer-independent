-- HOTFIX (production incident): migration 20260613140000 added a SELECT policy
-- on availability_slots whose USING clause queried public.bookings directly.
-- But bookings already carries SELECT policies that query availability_slots
-- (e.g. "Trainers can view bookings for their slots",
-- "Academy managers can view bookings for their trainers slots"). That closes a
-- cycle: reading either table forces Postgres to evaluate the other table's
-- policies, which re-enter the first — so EVERY read of bookings OR
-- availability_slots fails with 42P17 "infinite recursion detected in policy"
-- for every authenticated caller (players, trainers, academies). Core booking
-- and agenda reads are down.
--
-- Fix: move the booking lookup into a SECURITY DEFINER function. Inside such a
-- function the query runs as the function owner (which is exempt from RLS), so
-- bookings' policies are NOT evaluated and the cycle is broken. This mirrors the
-- existing definer helpers used in other policies (is_player_of_trainer,
-- get_profile_id_for_user). Behaviour is preserved: a player may still SELECT
-- any slot they hold a non-cancelled booking on (so a slot the trainer later
-- marks private still resolves on the player's own bookings join).

CREATE OR REPLACE FUNCTION public.player_has_active_booking_on_slot(_slot_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.bookings b
    WHERE b.slot_id = _slot_id
      AND b.player_id = public.get_profile_id_for_user(auth.uid())
      AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
  );
$$;

GRANT EXECUTE ON FUNCTION public.player_has_active_booking_on_slot(uuid) TO authenticated;

DROP POLICY IF EXISTS "Players can view slots they have booked" ON public.availability_slots;

CREATE POLICY "Players can view slots they have booked"
  ON public.availability_slots
  FOR SELECT
  TO authenticated
  USING (public.player_has_active_booking_on_slot(availability_slots.id));
