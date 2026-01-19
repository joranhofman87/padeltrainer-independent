-- Add policy to allow public reading of profiles for trainer discovery
-- This is needed because profiles_public view uses security_invoker=on
CREATE POLICY "Anyone can view public profile data"
  ON public.profiles
  FOR SELECT
  USING (true);

-- Drop the old restrictive policy since the new one supersedes it
DROP POLICY IF EXISTS "Users can view their own profile" ON public.profiles;