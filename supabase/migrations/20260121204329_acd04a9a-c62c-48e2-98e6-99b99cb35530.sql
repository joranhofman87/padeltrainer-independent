-- Drop the existing INSERT policy on club_profiles
DROP POLICY IF EXISTS "Authenticated users can create club profiles (claims)" ON public.club_profiles;

-- Recreate as a PERMISSIVE policy (default, but being explicit)
CREATE POLICY "Authenticated users can create club profiles"
ON public.club_profiles
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() IS NOT NULL);