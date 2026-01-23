-- Allow club managers to upload club logos
CREATE POLICY "Club managers can upload club logos"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'avatars' AND
  (storage.foldername(name))[1] = 'clubs' AND
  (storage.foldername(name))[2]::uuid IN (
    SELECT club_profile_id
    FROM public.club_managers
    WHERE user_id = auth.uid()
  )
);

-- Allow club managers to update (upsert) club logos
CREATE POLICY "Club managers can update club logos"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'avatars' AND
  (storage.foldername(name))[1] = 'clubs' AND
  (storage.foldername(name))[2]::uuid IN (
    SELECT club_profile_id
    FROM public.club_managers
    WHERE user_id = auth.uid()
  )
)
WITH CHECK (
  bucket_id = 'avatars' AND
  (storage.foldername(name))[1] = 'clubs' AND
  (storage.foldername(name))[2]::uuid IN (
    SELECT club_profile_id
    FROM public.club_managers
    WHERE user_id = auth.uid()
  )
);