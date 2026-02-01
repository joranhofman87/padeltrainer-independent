-- Allow admins to upload trainer avatars to trainers/ folder
CREATE POLICY "Admins can upload trainer avatars"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'avatars' 
  AND (storage.foldername(name))[1] = 'trainers'
  AND public.is_admin(auth.uid())
);

-- Allow admins to update trainer avatars
CREATE POLICY "Admins can update trainer avatars"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'avatars' 
  AND (storage.foldername(name))[1] = 'trainers'
  AND public.is_admin(auth.uid())
);

-- Allow admins to delete trainer avatars
CREATE POLICY "Admins can delete trainer avatars"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'avatars' 
  AND (storage.foldername(name))[1] = 'trainers'
  AND public.is_admin(auth.uid())
);