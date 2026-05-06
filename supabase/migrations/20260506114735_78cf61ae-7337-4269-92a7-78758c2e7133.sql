ALTER TABLE public.guest_players
  ADD COLUMN IF NOT EXISTS billing_business_name text,
  ADD COLUMN IF NOT EXISTS billing_address text,
  ADD COLUMN IF NOT EXISTS billing_btw_number text;