-- Fix trainer_profiles UPDATE policy to include 'club_trainer' relationship type
DROP POLICY IF EXISTS "Club managers can update trainer profiles at their locations" ON public.trainer_profiles;

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
        AND tl.relationship_type IN ('club', 'club_trainer')
    )
  );

-- Recreate profiles UPDATE policy (ensure it includes both types)
DROP POLICY IF EXISTS "Club managers can update profiles for club trainers" ON public.profiles;

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
        AND tl.relationship_type IN ('club', 'club_trainer')
    )
  );