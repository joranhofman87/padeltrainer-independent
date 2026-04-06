
-- ============================================================
-- Fix: Strip sensitive financial columns from public-facing views
-- and remove overly permissive public SELECT policies on base tables
-- ============================================================

-- 1. Recreate trainer_profiles_safe WITHOUT sensitive columns
DROP VIEW IF EXISTS public.trainer_profiles_safe;
CREATE VIEW public.trainer_profiles_safe AS
  SELECT
    id,
    user_id,
    slug,
    hourly_rate,
    CASE
      WHEN coaching_since_year IS NOT NULL THEN (EXTRACT(year FROM CURRENT_DATE))::integer - coaching_since_year
      ELSE experience_years
    END AS experience_years,
    certifications,
    specializations,
    is_verified,
    knltb_rating,
    trainer_rating_system,
    coaching_method,
    favourite_quote,
    video_url,
    website_url,
    social_instagram,
    social_tiktok,
    social_youtube,
    social_linkedin,
    preferred_min_rating,
    preferred_max_rating,
    preferred_rating_system,
    is_public,
    slot_duration_minutes,
    schedule_weeks_ahead,
    require_booking_approval,
    waiting_list_enabled,
    created_at,
    updated_at
  FROM public.trainer_profiles;
-- No security_invoker = bypasses RLS (runs as view owner / postgres)

-- 2. Recreate academy_profiles_safe WITHOUT sensitive columns
DROP VIEW IF EXISTS public.academy_profiles_safe;
CREATE VIEW public.academy_profiles_safe AS
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
    is_public,
    is_verified,
    country,
    timezone,
    welcome_message,
    waiting_list_enabled,
    created_at,
    updated_at
  FROM public.academy_profiles;
-- No security_invoker = bypasses RLS

-- 3. Recreate club_profiles_safe (already clean, but ensure no security_invoker)
DROP VIEW IF EXISTS public.club_profiles_safe;
CREATE VIEW public.club_profiles_safe AS
  SELECT
    id,
    location_id,
    description,
    logo_url,
    banner_url,
    is_verified,
    social_instagram,
    social_facebook,
    social_tiktok,
    social_youtube,
    social_linkedin,
    welcome_message,
    created_at,
    updated_at
  FROM public.club_profiles
  WHERE is_verified = true;
-- No security_invoker = bypasses RLS

-- 4. Remove overly permissive public SELECT policies from base tables
-- These allowed ANY user to read ALL columns (including IBAN, mollie IDs, etc.)
DROP POLICY IF EXISTS "Anyone can view public trainer profiles data" ON public.trainer_profiles;
DROP POLICY IF EXISTS "Anyone can view verified public academies" ON public.academy_profiles;
DROP POLICY IF EXISTS "Anyone can view verified club profiles" ON public.club_profiles;
DROP POLICY IF EXISTS "Authenticated users can view verified club profiles" ON public.club_profiles;
