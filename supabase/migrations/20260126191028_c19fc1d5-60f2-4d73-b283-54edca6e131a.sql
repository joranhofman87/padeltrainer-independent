-- Recreate the trainer_profiles_safe view to include ALL needed columns
DROP VIEW IF EXISTS public.trainer_profiles_safe;
CREATE VIEW public.trainer_profiles_safe
WITH (security_invoker = on) AS
SELECT
  id, user_id, hourly_rate, experience_years, certifications,
  specializations, is_verified, knltb_rating, trainer_rating_system,
  coaching_method, favourite_quote, video_url, website_url,
  social_instagram, social_tiktok, social_youtube, social_linkedin,
  preferred_min_rating, preferred_max_rating, preferred_rating_system,
  is_public, slot_duration_minutes, schedule_weeks_ahead,
  subscription_status, trial_ends_at, require_booking_approval, use_manual_invoicing,
  created_at, updated_at
FROM trainer_profiles;