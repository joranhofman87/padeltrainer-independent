
-- Add stripe_customer_id to all profile tables
ALTER TABLE public.trainer_profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE public.club_profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE public.academy_profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

-- Add stripe price ID columns to subscription_plans
ALTER TABLE public.subscription_plans ADD COLUMN IF NOT EXISTS stripe_price_id_monthly TEXT;
ALTER TABLE public.subscription_plans ADD COLUMN IF NOT EXISTS stripe_price_id_yearly TEXT;
