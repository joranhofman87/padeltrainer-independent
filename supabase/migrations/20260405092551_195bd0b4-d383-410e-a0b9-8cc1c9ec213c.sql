
-- Add birth_date to guest_players
ALTER TABLE public.guest_players ADD COLUMN IF NOT EXISTS birth_date date;

-- Add warning threshold columns to academy_profiles
ALTER TABLE public.academy_profiles ADD COLUMN IF NOT EXISTS warning_max_rating_spread numeric;
ALTER TABLE public.academy_profiles ADD COLUMN IF NOT EXISTS warning_max_age_diff_years integer;

-- Backfill guest_players.birth_date from intake_requests where possible
UPDATE public.guest_players gp
SET birth_date = ir.birth_date
FROM public.intake_requests ir
WHERE gp.birth_date IS NULL
  AND ir.birth_date IS NOT NULL
  AND (
    (ir.guest_player_id IS NOT NULL AND ir.guest_player_id = gp.id)
    OR (ir.guest_player_id IS NULL AND lower(ir.email) = lower(gp.email))
  );
