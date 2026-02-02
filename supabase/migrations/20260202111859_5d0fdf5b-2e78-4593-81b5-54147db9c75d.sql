-- Add country column to academy_profiles
ALTER TABLE academy_profiles 
ADD COLUMN country TEXT NOT NULL DEFAULT 'NL';

-- Add comment for clarity
COMMENT ON COLUMN academy_profiles.country IS 'ISO 3166-1 alpha-2 country code';

-- Update the academy_profiles_public view to include country
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
  country
FROM academy_profiles
WHERE is_public = true;

-- Update the academy_profiles_safe view to include country
DROP VIEW IF EXISTS academy_profiles_safe;
CREATE VIEW academy_profiles_safe WITH (security_invoker = on) AS
SELECT 
  id,
  name,
  slug,
  description,
  logo_url,
  banner_url,
  contact_email,
  phone,
  website_url,
  social_instagram,
  social_facebook,
  social_linkedin,
  social_youtube,
  social_tiktok,
  is_public,
  is_verified,
  subscription_status,
  subscription_tier,
  trial_ends_at,
  subscription_ends_at,
  created_at,
  updated_at,
  country
FROM academy_profiles;