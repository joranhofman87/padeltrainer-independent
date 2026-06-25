-- Registration↔cycle split (Phase 2) — carry the training SPAN on the registration.
--
-- A per-lesson registration form prices each chosen lesson type as (price × number_of_weeks), and
-- the number of weeks falls back to the cycle's start_date→end_date span (both client preview in
-- CycleApplicationForm and server charge in registration-pricing.ts). After the split the form is
-- served from the `registrations` row (the source cycle is re-designated type='cyclus'), so the
-- span must live on the registration too — otherwise post-backfill those forms would preview AND
-- charge €0 (weeks=null → no price).
--
-- Additive + nullable; backfilled from the source cycle in the cutover migration (Step 3). Events
-- and package/duration registrations don't use the span, so null is harmless for them.
ALTER TABLE public.registrations
  ADD COLUMN IF NOT EXISTS start_date date,
  ADD COLUMN IF NOT EXISTS end_date date;
