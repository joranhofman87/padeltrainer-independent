-- Add trainer_rating_system column to trainer_profiles
ALTER TABLE public.trainer_profiles
ADD COLUMN IF NOT EXISTS trainer_rating_system text DEFAULT 'knltb';