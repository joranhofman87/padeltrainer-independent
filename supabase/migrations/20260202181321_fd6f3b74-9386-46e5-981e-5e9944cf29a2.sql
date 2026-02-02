-- Allow admins to upload location images
CREATE POLICY "Admins can upload location images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'avatars' 
  AND (storage.foldername(name))[1] = 'locations'
  AND public.is_admin(auth.uid())
);

-- Allow admins to update location images
CREATE POLICY "Admins can update location images"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'avatars' 
  AND (storage.foldername(name))[1] = 'locations'
  AND public.is_admin(auth.uid())
);

-- Allow admins to delete location images
CREATE POLICY "Admins can delete location images"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'avatars' 
  AND (storage.foldername(name))[1] = 'locations'
  AND public.is_admin(auth.uid())
);