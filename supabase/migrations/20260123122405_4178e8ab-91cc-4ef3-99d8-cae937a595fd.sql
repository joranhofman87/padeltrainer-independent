-- F11: Allow anonymous users to view trainer profiles
-- This enables the 7 existing trainers to be visible on /nl/trainers

CREATE POLICY "Anonymous can view trainer profiles"
ON public.trainer_profiles
FOR SELECT
TO anon
USING (true);