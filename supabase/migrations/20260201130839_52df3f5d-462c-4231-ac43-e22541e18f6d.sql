-- Add slug column to trainer_profiles for SEO-friendly URLs
ALTER TABLE public.trainer_profiles ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE;

-- Create function to generate trainer slug from profile name (without unaccent)
CREATE OR REPLACE FUNCTION public.generate_trainer_slug(full_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $$
BEGIN
  RETURN lower(
    regexp_replace(
      regexp_replace(
        COALESCE(full_name, ''),
        '[^a-zA-Z0-9\-]', '-', 'g'
      ),
      '-+', '-', 'g'
    )
  );
END;
$$;

-- Populate slugs for existing trainers using their profile names
UPDATE public.trainer_profiles tp
SET slug = (
  SELECT public.generate_trainer_slug(p.full_name)
  FROM public.profiles p
  WHERE p.user_id = tp.user_id
)
WHERE tp.slug IS NULL;

-- Handle duplicate slugs by appending a unique suffix
WITH duplicates AS (
  SELECT id, slug, 
    ROW_NUMBER() OVER (PARTITION BY slug ORDER BY created_at) as rn
  FROM public.trainer_profiles
  WHERE slug IS NOT NULL
)
UPDATE public.trainer_profiles tp
SET slug = d.slug || '-' || d.rn
FROM duplicates d
WHERE tp.id = d.id AND d.rn > 1;

-- Create index for slug lookups
CREATE INDEX IF NOT EXISTS idx_trainer_profiles_slug ON public.trainer_profiles(slug);

-- Update the trainer_profiles_safe view to include slug
DROP VIEW IF EXISTS public.trainer_profiles_safe;
CREATE VIEW public.trainer_profiles_safe
WITH (security_invoker = on) AS
SELECT
  id, user_id, slug, hourly_rate, experience_years, certifications,
  specializations, is_verified, knltb_rating, trainer_rating_system,
  coaching_method, favourite_quote, video_url, website_url,
  social_instagram, social_tiktok, social_youtube, social_linkedin,
  preferred_min_rating, preferred_max_rating, preferred_rating_system,
  is_public, slot_duration_minutes, schedule_weeks_ahead,
  subscription_status, trial_ends_at, require_booking_approval, use_manual_invoicing,
  created_at, updated_at
FROM trainer_profiles;

-- Grant access
GRANT SELECT ON public.trainer_profiles_safe TO anon;
GRANT SELECT ON public.trainer_profiles_safe TO authenticated;