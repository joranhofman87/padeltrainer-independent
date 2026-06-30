-- Reusable academy default "rebooking rules" (rich HTML).
-- Shown in the rebooking invitation email above the accept/decline buttons, and gated by an
-- "I agree to the rebooking rules" opt-in on the rebooking claim/pay page before the player pays.
-- A per-round override can still be stored on cycles.settings.rebook_rules; this column is the
-- academy-level default that pre-fills new rebookings.
--
-- Additive + backward-compatible: existing rows are NULL ("no rules"). The frontend reads it
-- tolerantly and degrades to blank if this column isn't present yet, so deploy order does not matter.

ALTER TABLE public.academy_profiles
  ADD COLUMN IF NOT EXISTS rebook_rules text;

COMMENT ON COLUMN public.academy_profiles.rebook_rules IS
  'Academy default rebooking rules (rich HTML) shown in the rebook invite + gated by an opt-in on the claim/pay page. NULL = none.';
