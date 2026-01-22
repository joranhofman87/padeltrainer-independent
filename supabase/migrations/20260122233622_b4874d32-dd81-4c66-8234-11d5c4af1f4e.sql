-- Allow trainers to delete bookings for their slots
CREATE POLICY "Trainers can delete bookings for their slots"
ON bookings FOR DELETE
USING (
  slot_id IN (
    SELECT availability_slots.id
    FROM availability_slots
    WHERE availability_slots.trainer_id IN (
      SELECT trainer_profiles.id
      FROM trainer_profiles
      WHERE trainer_profiles.user_id = auth.uid()
    )
  )
);

-- Also allow trainers to delete bookings for their guest players
CREATE POLICY "Trainers can delete bookings for their guest players"
ON bookings FOR DELETE
USING (
  guest_player_id IS NOT NULL AND
  guest_player_id IN (
    SELECT gp.id
    FROM guest_players gp
    JOIN trainer_profiles tp ON gp.trainer_id = tp.id
    WHERE tp.user_id = auth.uid()
  )
);