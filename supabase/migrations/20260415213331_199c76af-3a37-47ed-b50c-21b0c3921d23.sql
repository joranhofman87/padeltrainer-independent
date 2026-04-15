ALTER TABLE public.academy_profiles ADD COLUMN invoice_include_year boolean NOT NULL DEFAULT true;
ALTER TABLE public.trainer_profiles ADD COLUMN invoice_include_year boolean NOT NULL DEFAULT true;