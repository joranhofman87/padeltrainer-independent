-- Recreate the view with SECURITY INVOKER to respect the querying user's permissions
DROP VIEW IF EXISTS public.club_profiles_public;

CREATE VIEW public.club_profiles_public
WITH (security_invoker = on)
AS
SELECT
  id,
  location_id,
  description,
  logo_url,
  banner_url,
  is_verified,
  claimed_at,
  created_at,
  updated_at,
  subscription_status,
  subscription_tier
FROM public.club_profiles
WHERE is_verified = true;

-- Grant public access to the view
GRANT SELECT ON public.club_profiles_public TO anon, authenticated;