-- Academy-level price display preference (incl./excl. VAT labels). Not tax calculation.
ALTER TABLE public.academy_profiles
  ADD COLUMN IF NOT EXISTS price_display_mode text NOT NULL DEFAULT 'including_vat';

ALTER TABLE public.academy_profiles
  DROP CONSTRAINT IF EXISTS academy_profiles_price_display_mode_check;

ALTER TABLE public.academy_profiles
  ADD CONSTRAINT academy_profiles_price_display_mode_check
  CHECK (price_display_mode IN ('including_vat', 'excluding_vat'));

COMMENT ON COLUMN public.academy_profiles.price_display_mode IS
  'How academy prices are shown to players: including_vat or excluding_vat.';
