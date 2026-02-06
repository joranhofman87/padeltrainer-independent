-- Recreate profiles_public view WITHOUT the phone column for PII protection
DROP VIEW IF EXISTS public.profiles_public;
CREATE VIEW public.profiles_public
WITH (security_invoker = off)
AS
SELECT
  id,
  user_id,
  full_name,
  avatar_url,
  bio,
  location,
  skill_rating,
  rating_system,
  rating_member_id,
  created_at,
  updated_at
FROM public.profiles;

-- Grant access to the view
GRANT SELECT ON public.profiles_public TO anon, authenticated;

-- Add RLS policy allowing anyone to read profiles of public trainers
-- This ensures logged-in players can see trainer profile data
CREATE POLICY "Anyone can view public trainer profiles"
  ON public.profiles
  FOR SELECT
  TO public
  USING (
    user_id IN (
      SELECT user_id FROM public.trainer_profiles WHERE is_public = true
    )
  );
