ALTER TABLE public.trainer_profiles ADD COLUMN IF NOT EXISTS last_processed_payment_id text;
ALTER TABLE public.academy_profiles ADD COLUMN IF NOT EXISTS last_processed_payment_id text;
ALTER TABLE public.club_profiles ADD COLUMN IF NOT EXISTS last_processed_payment_id text;