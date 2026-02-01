-- Drop and recreate academy_profiles_public with security_invoker enabled
DROP VIEW IF EXISTS public.academy_profiles_public;

CREATE VIEW public.academy_profiles_public
WITH (security_invoker = on)
AS
SELECT 
  id,
  name,
  slug,
  description,
  logo_url,
  banner_url,
  website_url,
  social_instagram,
  social_facebook,
  social_linkedin,
  social_youtube,
  social_tiktok,
  is_verified,
  is_public,
  subscription_status,
  subscription_tier,
  created_at,
  updated_at
FROM public.academy_profiles
WHERE is_public = true;

-- Grant access to both roles
GRANT SELECT ON public.academy_profiles_public TO anon;
GRANT SELECT ON public.academy_profiles_public TO authenticated;