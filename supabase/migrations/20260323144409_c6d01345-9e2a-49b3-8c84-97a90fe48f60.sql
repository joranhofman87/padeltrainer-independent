
ALTER TABLE public.trainer_profiles 
  ADD COLUMN IF NOT EXISTS prices_include_vat boolean NOT NULL DEFAULT true;

ALTER TABLE public.availability_slots 
  ADD COLUMN IF NOT EXISTS prices_include_vat boolean NOT NULL DEFAULT true;
