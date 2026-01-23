-- Fix trainer_profile_views INSERT policy to require authentication
DROP POLICY IF EXISTS "Anyone can insert profile views" ON public.trainer_profile_views;

CREATE POLICY "Authenticated users can insert profile views" 
ON public.trainer_profile_views 
FOR INSERT 
WITH CHECK (auth.uid() IS NOT NULL);