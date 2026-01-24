-- Add policy to allow anonymous users to view verified club profiles (public access)
CREATE POLICY "Anyone can view verified club profiles"
ON public.club_profiles
FOR SELECT
USING (is_verified = true);