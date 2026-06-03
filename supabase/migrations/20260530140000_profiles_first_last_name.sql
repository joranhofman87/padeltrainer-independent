-- Phase 1: structured profile names (additive; full_name unchanged)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT;

COMMENT ON COLUMN public.profiles.first_name IS 'Given name; optional; may be backfilled from full_name';
COMMENT ON COLUMN public.profiles.last_name IS 'Family name; optional; may be backfilled from full_name';

-- Conservative backfill: first token -> first_name, remainder -> last_name
UPDATE public.profiles
SET
  first_name = CASE
    WHEN full_name IS NULL OR btrim(full_name) = '' THEN NULL
    WHEN position(' ' IN btrim(full_name)) = 0 THEN btrim(full_name)
    ELSE split_part(btrim(full_name), ' ', 1)
  END,
  last_name = CASE
    WHEN full_name IS NULL OR btrim(full_name) = '' THEN NULL
    WHEN position(' ' IN btrim(full_name)) = 0 THEN NULL
    ELSE btrim(substring(btrim(full_name) FROM position(' ' IN btrim(full_name)) + 1))
  END
WHERE first_name IS NULL
  AND last_name IS NULL;
