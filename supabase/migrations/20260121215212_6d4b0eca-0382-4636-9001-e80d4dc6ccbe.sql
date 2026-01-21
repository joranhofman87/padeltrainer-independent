-- Allow club managers to update trainer profiles for trainers at their club's locations
CREATE POLICY "Club managers can update trainer profiles at their locations"
  ON public.trainer_profiles
  FOR UPDATE
  TO authenticated
  USING (
    id IN (
      SELECT tl.trainer_id 
      FROM trainer_locations tl
      JOIN club_profiles cp ON cp.location_id = tl.location_id
      WHERE cp.id IN (SELECT get_user_club_ids(auth.uid()))
        AND tl.relationship_type = 'club'
    )
  );

-- Allow club managers to update profiles for trainers at their club's locations
CREATE POLICY "Club managers can update profiles for club trainers"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (
    user_id IN (
      SELECT tp.user_id
      FROM trainer_profiles tp
      JOIN trainer_locations tl ON tl.trainer_id = tp.id
      JOIN club_profiles cp ON cp.location_id = tl.location_id
      WHERE cp.id IN (SELECT get_user_club_ids(auth.uid()))
        AND tl.relationship_type = 'club'
    )
  );