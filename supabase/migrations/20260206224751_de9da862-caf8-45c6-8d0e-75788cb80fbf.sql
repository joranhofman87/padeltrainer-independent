
-- Allow trainers to view profiles of players who have booked on their slots
CREATE POLICY "Trainers can view booked player profiles"
  ON public.profiles FOR SELECT
  USING (
    id IN (
      SELECT DISTINCT b.player_id
      FROM bookings b
      JOIN availability_slots s ON s.id = b.slot_id
      JOIN trainer_profiles tp ON tp.id = s.trainer_id
      WHERE tp.user_id = auth.uid()
        AND b.player_id IS NOT NULL
    )
  );
