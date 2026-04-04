
-- Academy managers can upload avatars for their trainers
CREATE POLICY "Academy managers can upload trainer avatars"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'avatars' AND
    (storage.foldername(name))[1] IN (
      SELECT tp.user_id::text
      FROM trainer_profiles tp
      JOIN academy_trainers at ON at.trainer_profile_id = tp.id
      WHERE at.status = 'active'
        AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
    )
  );

CREATE POLICY "Academy managers can update trainer avatars"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'avatars' AND
    (storage.foldername(name))[1] IN (
      SELECT tp.user_id::text
      FROM trainer_profiles tp
      JOIN academy_trainers at ON at.trainer_profile_id = tp.id
      WHERE at.status = 'active'
        AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
    )
  );

-- Academy managers can update profiles for their trainers
CREATE POLICY "Academy managers can update profiles for academy trainers"
  ON public.profiles FOR UPDATE TO authenticated
  USING (
    user_id IN (
      SELECT tp.user_id
      FROM trainer_profiles tp
      JOIN academy_trainers at ON at.trainer_profile_id = tp.id
      WHERE at.status = 'active'
        AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
    )
  );
