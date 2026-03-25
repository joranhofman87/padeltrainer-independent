
CREATE POLICY "Players can view profiles of their trainers"
  ON public.trainer_profiles FOR SELECT
  TO authenticated
  USING (
    id IN (
      SELECT DISTINCT s.trainer_id 
      FROM bookings b
      JOIN availability_slots s ON s.id = b.slot_id
      WHERE b.player_id IN (
        SELECT id FROM profiles WHERE user_id = auth.uid()
      )
    )
  );

CREATE POLICY "Anyone can view public trainer profiles data"
  ON public.trainer_profiles FOR SELECT
  TO authenticated
  USING (is_public = true);
