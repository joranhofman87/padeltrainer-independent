-- Academy managers can upload to academies folder in avatars bucket
CREATE POLICY "Academy managers can upload academy images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'avatars' AND
  (storage.foldername(name))[1] = 'academies' AND
  ((storage.foldername(name))[2])::uuid IN (
    SELECT get_user_academy_ids(auth.uid())
  )
);

-- Academy managers can update their academy images
CREATE POLICY "Academy managers can update academy images"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'avatars' AND
  (storage.foldername(name))[1] = 'academies' AND
  ((storage.foldername(name))[2])::uuid IN (
    SELECT get_user_academy_ids(auth.uid())
  )
);