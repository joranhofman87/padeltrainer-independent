-- Repair: academy_profiles.mollie_customer_id never added in migrations
-- (trainer got it in 20260204091845; club via rename in 20260203100646).
-- Idempotent schema-only. No data changes.
-- Required before 20260511183528 REVOKE on mollie_customer_id.

ALTER TABLE public.academy_profiles
  ADD COLUMN IF NOT EXISTS mollie_customer_id TEXT;
