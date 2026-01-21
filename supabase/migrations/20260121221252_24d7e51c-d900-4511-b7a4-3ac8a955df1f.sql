-- Fix RLS policy for avatars storage: Allow club managers to upload avatars for their trainers
CREATE POLICY "Club managers can upload trainer avatars"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'avatars' AND
    (storage.foldername(name))[1] IN (
      SELECT tp.user_id::text
      FROM trainer_profiles tp
      JOIN trainer_locations tl ON tl.trainer_id = tp.id
      JOIN club_profiles cp ON cp.location_id = tl.location_id
      WHERE cp.id IN (SELECT get_user_club_ids(auth.uid()))
        AND tl.relationship_type IN ('club', 'club_trainer')
    )
  );

CREATE POLICY "Club managers can update trainer avatars"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'avatars' AND
    (storage.foldername(name))[1] IN (
      SELECT tp.user_id::text
      FROM trainer_profiles tp
      JOIN trainer_locations tl ON tl.trainer_id = tp.id
      JOIN club_profiles cp ON cp.location_id = tl.location_id
      WHERE cp.id IN (SELECT get_user_club_ids(auth.uid()))
        AND tl.relationship_type IN ('club', 'club_trainer')
    )
  );

-- Fix profiles UPDATE policy to include 'club_trainer' relationship type
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