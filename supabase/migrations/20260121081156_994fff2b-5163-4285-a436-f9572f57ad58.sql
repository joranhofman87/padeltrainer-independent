-- Allow authenticated users to view all profiles (for public profile data)
CREATE POLICY "Authenticated users can view all profiles"
ON public.profiles
FOR SELECT
TO authenticated
USING (true);