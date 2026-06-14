-- Phase 5 follow-up: VALIDATE the date-order CHECKs added NOT VALID in
-- 20260614170000 (availability_slots) and 20260614180000 (cycles).
--
-- VALIDATE scans existing rows and would ABORT if any violate, so we can't blind
-- a plain VALIDATE at prod. Instead: count violators first and VALIDATE only when
-- the count is 0 (the expected case). If a legacy bad row exists, the constraint
-- stays NOT VALID (still enforced for new writes) and we surface a WARNING with
-- the count + the query to find them — the migration still applies cleanly, never
-- breaking the deploy. On a fresh CI stack the tables are empty → both VALIDATE.

DO $$
DECLARE
  v_slots int;
BEGIN
  SELECT count(*) INTO v_slots
    FROM public.availability_slots WHERE end_time <= start_time;
  IF v_slots = 0 THEN
    ALTER TABLE public.availability_slots VALIDATE CONSTRAINT availability_slots_time_order_check;
    RAISE NOTICE 'availability_slots_time_order_check: 0 violators → VALIDATED';
  ELSE
    RAISE WARNING 'availability_slots_time_order_check: % violator(s) — left NOT VALID. Fix: SELECT id, trainer_id, start_time, end_time FROM public.availability_slots WHERE end_time <= start_time; then ALTER TABLE public.availability_slots VALIDATE CONSTRAINT availability_slots_time_order_check;', v_slots;
  END IF;
END $$;

DO $$
DECLARE
  v_cycles int;
BEGIN
  SELECT count(*) INTO v_cycles
    FROM public.cycles
   WHERE start_date IS NOT NULL AND end_date IS NOT NULL AND end_date < start_date;
  IF v_cycles = 0 THEN
    ALTER TABLE public.cycles VALIDATE CONSTRAINT cycles_date_order_check;
    RAISE NOTICE 'cycles_date_order_check: 0 violators → VALIDATED';
  ELSE
    RAISE WARNING 'cycles_date_order_check: % violator(s) — left NOT VALID. Fix the rows then VALIDATE CONSTRAINT cycles_date_order_check;', v_cycles;
  END IF;
END $$;
