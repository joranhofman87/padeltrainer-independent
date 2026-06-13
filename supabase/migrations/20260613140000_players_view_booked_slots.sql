-- A player can only SELECT availability_slots that are public or that they
-- own/manage. If a trainer marks a slot private (is_public=false) AFTER players
-- booked it, the slot disappears from the player's own bookings join (PostgREST
-- returns the embedded slot as null), which hides the session they paid for and
-- can even crash the bookings page on a null start_time deref.
--
-- This adds a SELECT policy letting a player read any slot they hold a
-- non-cancelled booking on. Purely ADDITIVE (RLS SELECT policies are OR'd), so
-- it only widens visibility to the player's OWN booked slots — no cross-player
-- exposure (the EXISTS is scoped to the caller's own profile id).

CREATE POLICY "Players can view slots they have booked"
  ON public.availability_slots
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.slot_id = availability_slots.id
        AND b.player_id = public.get_profile_id_for_user(auth.uid())
        AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
    )
  );
