-- Allow anonymous users to view profiles (needed for public pages like club profiles)
CREATE POLICY "Anonymous users can view profiles"
ON public.profiles
FOR SELECT
TO anon
USING (true);