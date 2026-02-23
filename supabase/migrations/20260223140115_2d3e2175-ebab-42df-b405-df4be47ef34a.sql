ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS enrichment_failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS enrichment_error_msg text;