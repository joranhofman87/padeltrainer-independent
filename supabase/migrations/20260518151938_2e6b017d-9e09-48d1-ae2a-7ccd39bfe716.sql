ALTER TABLE public.cycles ADD COLUMN IF NOT EXISTS is_always_open boolean NOT NULL DEFAULT false;
ALTER TABLE public.cycles ALTER COLUMN start_date DROP NOT NULL;
ALTER TABLE public.cycles ALTER COLUMN end_date DROP NOT NULL;