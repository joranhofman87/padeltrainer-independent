
-- Allow club managers to update trainer_locations for trainers at their club's location
CREATE POLICY "Club managers can update trainer locations at their club"
ON public.trainer_locations
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM club_managers cm
    JOIN club_profiles cp ON cm.club_profile_id = cp.id
    WHERE cm.user_id = auth.uid()
    AND cp.location_id = trainer_locations.location_id
  )
);
