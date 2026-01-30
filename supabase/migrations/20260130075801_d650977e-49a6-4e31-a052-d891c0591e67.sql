-- Allow admins to upload academy images
CREATE POLICY "Admins can upload academy images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'avatars' 
  AND (storage.foldername(name))[1] = 'academies'
  AND is_admin(auth.uid())
);

-- Allow admins to update academy images
CREATE POLICY "Admins can update academy images"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'avatars' 
  AND (storage.foldername(name))[1] = 'academies'
  AND is_admin(auth.uid())
);

-- Allow admins to delete academy images
CREATE POLICY "Admins can delete academy images"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'avatars' 
  AND (storage.foldername(name))[1] = 'academies'
  AND is_admin(auth.uid())
);