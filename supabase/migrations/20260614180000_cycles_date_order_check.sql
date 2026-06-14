-- Phase 5 (P5-CHK-02): temporal-integrity guard on cycles.
--
-- A cycle with end_date < start_date is invalid and breaks term/rebooking maths
-- (the (location, term-end-week) cohort key, window scheduling). NULL-tolerant:
-- start_date/end_date were created NOT NULL (20260123104639) but NOT NULL was
-- DROPPED (20260518151938) for is_always_open cycles, so both are now NULLABLE
-- — the CHECK MUST allow NULLs. `<=` keeps single-day cycles (start = end) valid.
--
-- Shipped NOT VALID for the same reasons as P5-CHK-01: enforced for new writes
-- immediately, cannot abort the deploy on a legacy row, restore-safe.
--
-- FOLLOW-UP (after confirming the count is 0 on prod):
--   SELECT count(*) FROM public.cycles
--     WHERE start_date IS NOT NULL AND end_date IS NOT NULL AND end_date < start_date;  -- must be 0
--   ALTER TABLE public.cycles VALIDATE CONSTRAINT cycles_date_order_check;

ALTER TABLE public.cycles
  ADD CONSTRAINT cycles_date_order_check
  CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date) NOT VALID;
