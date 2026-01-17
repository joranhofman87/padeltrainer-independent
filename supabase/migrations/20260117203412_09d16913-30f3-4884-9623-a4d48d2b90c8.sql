-- Fix 1: Remove overly permissive INSERT policy on player_rating_history
-- Edge functions using service role key already bypass RLS entirely,
-- so this policy only enabled unauthorized user access
DROP POLICY IF EXISTS "Service role can insert rating history" ON public.player_rating_history;

-- Fix 2: Create a public view for profiles that excludes sensitive PII
-- Users should only see their own sensitive data (email, phone), but can see public info for all

-- First, drop the existing overly permissive SELECT policy
DROP POLICY IF EXISTS "Users can view all profiles" ON public.profiles;

-- Create a restrictive policy - users can only SELECT their own profile
CREATE POLICY "Users can view their own profile" 
ON public.profiles 
FOR SELECT 
USING (auth.uid() = user_id);

-- Create a view for public profile data that excludes sensitive fields
-- This can be used for displaying trainer/player names and public info
CREATE OR REPLACE VIEW public.profiles_public
WITH (security_invoker=on) AS
SELECT 
  id,
  user_id,
  full_name,
  avatar_url,
  bio,
  location,
  skill_rating,
  rating_system,
  knltb_number,
  created_at,
  updated_at
FROM public.profiles;

-- Grant access to the view for authenticated users
GRANT SELECT ON public.profiles_public TO authenticated;
GRANT SELECT ON public.profiles_public TO anon;