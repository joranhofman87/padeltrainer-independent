-- Allow club managers to insert trainer profiles for users
-- This enables clubs to create trainer accounts for their staff

CREATE POLICY "Club managers can insert trainer profiles"
  ON public.trainer_profiles
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_any_club_manager(auth.uid())
  );

-- Also allow club managers to view trainer profiles for trainers at their locations
CREATE POLICY "Club managers can view trainer profiles at their locations"
  ON public.trainer_profiles
  FOR SELECT
  TO authenticated
  USING (
    id IN (
      SELECT tl.trainer_id 
      FROM trainer_locations tl
      JOIN club_profiles cp ON cp.location_id = tl.location_id
      WHERE cp.id IN (SELECT get_user_club_ids(auth.uid()))
    )
  );