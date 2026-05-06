ALTER TABLE public.academy_profiles ADD COLUMN IF NOT EXISTS invoice_reply_to_email text;
ALTER TABLE public.trainer_profiles ADD COLUMN IF NOT EXISTS invoice_reply_to_email text;