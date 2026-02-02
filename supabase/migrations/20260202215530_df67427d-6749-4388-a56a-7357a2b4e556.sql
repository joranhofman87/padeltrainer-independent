-- Fix academy_profiles_public view to include missing columns
DROP VIEW IF EXISTS academy_profiles_public;
CREATE VIEW academy_profiles_public WITH (security_invoker = on) AS
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
  country
FROM academy_profiles
WHERE is_public = true;