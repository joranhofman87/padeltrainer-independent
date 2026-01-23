-- Update the policy to require authentication for viewing verified club profiles
DROP POLICY IF EXISTS "Anyone can view verified club profiles" ON public.club_profiles;

CREATE POLICY "Authenticated users can view verified club profiles" 
ON public.club_profiles 
FOR SELECT 
USING (is_verified = true AND auth.uid() IS NOT NULL);