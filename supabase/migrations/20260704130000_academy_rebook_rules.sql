-- Reusable academy default "rebooking rules" (rich HTML).
-- The rules players must agree to (an "I agree to the rebooking rules" opt-in) on the rebooking
-- claim/pay page before they keep/pay for their spot. NOT shown in the invitation email — that
-- keeps its own separate free-text message above the buttons.
-- A per-round override can still be stored on cycles.settings.rebook_rules; this column is the
-- academy-level default that pre-fills new rebookings.
--
-- Additive + backward-compatible: existing rows are NULL ("no rules"). The frontend reads it
-- tolerantly and degrades to blank if this column isn't present yet, so deploy order does not matter.

ALTER TABLE public.academy_profiles
  ADD COLUMN IF NOT EXISTS rebook_rules text;

COMMENT ON COLUMN public.academy_profiles.rebook_rules IS
  'Academy default rebooking rules (rich HTML) the player must agree to via an opt-in on the rebooking claim/pay page (NOT shown in the invite email). NULL = none.';
