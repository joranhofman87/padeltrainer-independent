
-- Add coaching_since_year column
ALTER TABLE public.trainer_profiles ADD COLUMN coaching_since_year integer;

-- Migrate existing data: coaching_since_year = 2026 - experience_years
UPDATE public.trainer_profiles 
SET coaching_since_year = 2026 - experience_years 
WHERE experience_years IS NOT NULL;
