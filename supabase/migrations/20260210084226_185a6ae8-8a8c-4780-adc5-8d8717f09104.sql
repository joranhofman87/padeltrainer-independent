ALTER TABLE public.trainer_profiles ADD COLUMN IF NOT EXISTS invoice_logo_url text;
ALTER TABLE public.trainer_profiles ADD COLUMN IF NOT EXISTS invoice_prefix text DEFAULT 'INV';
ALTER TABLE public.trainer_profiles ADD COLUMN IF NOT EXISTS invoice_next_number integer DEFAULT 1;