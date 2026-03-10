ALTER TABLE public.cycles ADD COLUMN IF NOT EXISTS terms text;
ALTER TABLE public.cycles ADD COLUMN IF NOT EXISTS price_table jsonb;