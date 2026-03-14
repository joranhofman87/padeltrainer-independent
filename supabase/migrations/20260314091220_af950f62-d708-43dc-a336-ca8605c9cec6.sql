ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE public.user_discounts ADD COLUMN IF NOT EXISTS stripe_coupon_id TEXT;