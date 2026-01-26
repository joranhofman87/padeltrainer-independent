-- Add website_url column to trainer_profiles
ALTER TABLE public.trainer_profiles ADD COLUMN website_url TEXT;

-- Update the safe view to include website_url
DROP VIEW IF EXISTS public.trainer_profiles_safe;
CREATE VIEW public.trainer_profiles_safe
WITH (security_invoker = on) AS
SELECT
  id, user_id, hourly_rate, experience_years, certifications,
  specializations, is_verified, knltb_rating, trainer_rating_system,
  coaching_method, favourite_quote, video_url, website_url,
  social_instagram, social_tiktok, social_youtube, social_linkedin,
  preferred_min_rating, preferred_max_rating, preferred_rating_system,
  is_public, slot_duration_minutes, schedule_weeks_ahead, created_at, updated_at
FROM trainer_profiles;