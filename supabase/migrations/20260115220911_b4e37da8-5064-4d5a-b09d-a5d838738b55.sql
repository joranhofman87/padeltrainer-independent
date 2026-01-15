-- Add KNLTB rating column to trainer_profiles
ALTER TABLE public.trainer_profiles
ADD COLUMN knltb_rating numeric NULL;

-- Add a comment for documentation
COMMENT ON COLUMN public.trainer_profiles.knltb_rating IS 'KNLTB tennis rating for the trainer';