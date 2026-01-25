-- Phase 1: Security Fixes

-- Create secure profiles view (excludes email, phone)
CREATE OR REPLACE VIEW profiles_safe 
WITH (security_invoker = on) AS
SELECT 
  id, user_id, full_name, avatar_url, bio, location, 
  skill_rating, rating_system, rating_member_id, created_at, updated_at
FROM profiles;

-- Create secure trainer_profiles view (excludes Stripe/business data)
CREATE OR REPLACE VIEW trainer_profiles_safe
WITH (security_invoker = on) AS
SELECT
  id, user_id, hourly_rate, experience_years, certifications,
  specializations, is_verified, knltb_rating, trainer_rating_system,
  coaching_method, favourite_quote, video_url, 
  social_instagram, social_tiktok, social_youtube, social_linkedin,
  preferred_min_rating, preferred_max_rating, preferred_rating_system,
  is_public, slot_duration_minutes, schedule_weeks_ahead, created_at, updated_at
FROM trainer_profiles
WHERE is_public = true;

-- Create secure club_profiles view (excludes contact/subscription data)
CREATE OR REPLACE VIEW club_profiles_safe
WITH (security_invoker = on) AS
SELECT
  id, location_id, description, logo_url, banner_url, is_verified,
  social_instagram, social_facebook, social_tiktok, 
  social_youtube, social_linkedin, created_at, updated_at
FROM club_profiles
WHERE is_verified = true;

-- Add RLS policy for rate_limits table (deny all direct access, service role bypasses RLS)
CREATE POLICY "Deny direct access to rate_limits" ON rate_limits
  FOR ALL USING (false);