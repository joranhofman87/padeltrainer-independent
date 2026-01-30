CREATE OR REPLACE VIEW public.academy_profiles_public AS
SELECT 
  id, name, slug, description, logo_url, banner_url, website_url,
  social_instagram, social_facebook, social_linkedin, social_youtube, social_tiktok,
  is_verified, is_public, subscription_status, subscription_tier,
  created_at, updated_at
FROM academy_profiles
WHERE is_public = true;