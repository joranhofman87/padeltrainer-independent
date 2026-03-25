-- Allow admin users to view all guest players
CREATE POLICY "Admins can view all guest players"
  ON public.guest_players FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- Allow admin users to view all bookings
CREATE POLICY "Admins can view all bookings"
  ON public.bookings FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));