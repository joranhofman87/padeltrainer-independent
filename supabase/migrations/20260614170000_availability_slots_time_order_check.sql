-- Phase 5 (P5-CHK-01): temporal-integrity guard on availability_slots.
--
-- A slot with end_time <= start_time is nonsensical (zero/negative-length
-- session) and silently corrupts every downstream consumer that treats the
-- slot as a real interval: capacity windows, the calendar occupancy maths, the
-- (location, term-end-week) cohort clustering, booking validity. Nothing in the
-- schema forbids it today. Both columns are NOT NULL (20260115210247), so a
-- strict `>` (which also rejects zero-length slots) needs no NULL guard.
--
-- Shipped as NOT VALID: it is ENFORCED for every new INSERT/UPDATE immediately
-- (the actual goal — forward protection), but does NOT scan existing rows, so a
-- single legacy bad row cannot abort this deploy, and pg_restore won't
-- re-validate it (the restore-safety concern that made 20260506095426 prefer a
-- trigger over a CHECK is neutralised by NOT VALID).
--
-- FOLLOW-UP (run once, after confirming the count below is 0 on prod):
--   SELECT count(*) FROM public.availability_slots WHERE end_time <= start_time;  -- must be 0
--   ALTER TABLE public.availability_slots VALIDATE CONSTRAINT availability_slots_time_order_check;
-- VALIDATE takes only a SHARE UPDATE EXCLUSIVE lock (no full rewrite). If the
-- count is > 0, fix/delete the violators first.

ALTER TABLE public.availability_slots
  ADD CONSTRAINT availability_slots_time_order_check
  CHECK (end_time > start_time) NOT VALID;
