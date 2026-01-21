-- Add new columns to trainer_profiles for enhanced landing page
ALTER TABLE public.trainer_profiles 
ADD COLUMN IF NOT EXISTS coaching_method TEXT,
ADD COLUMN IF NOT EXISTS favourite_quote TEXT,
ADD COLUMN IF NOT EXISTS video_url TEXT,
ADD COLUMN IF NOT EXISTS social_instagram TEXT,
ADD COLUMN IF NOT EXISTS social_tiktok TEXT,
ADD COLUMN IF NOT EXISTS social_youtube TEXT,
ADD COLUMN IF NOT EXISTS social_linkedin TEXT,
ADD COLUMN IF NOT EXISTS preferred_min_rating NUMERIC,
ADD COLUMN IF NOT EXISTS preferred_max_rating NUMERIC,
ADD COLUMN IF NOT EXISTS preferred_rating_system TEXT DEFAULT 'knltb';