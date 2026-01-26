-- Recreate profiles_public view with security_definer (invoker = off)
-- This allows anonymous access to non-sensitive fields only
-- The view itself is the security boundary - it only exposes safe columns

DROP VIEW IF EXISTS public.profiles_public;

CREATE VIEW public.profiles_public
WITH (security_invoker = off) AS
SELECT 
  id,
  user_id,
  full_name,
  avatar_url,
  bio,
  location,
  skill_rating,
  rating_system,
  rating_member_id AS knltb_number,
  created_at,
  updated_at
FROM public.profiles;

-- Ensure both anon and authenticated roles can query the view
GRANT SELECT ON public.profiles_public TO anon;
GRANT SELECT ON public.profiles_public TO authenticated;