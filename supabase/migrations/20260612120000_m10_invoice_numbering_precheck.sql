-- M-10 pre-flight (NOTICE-ONLY, no mutations): before adding a uniqueness
-- constraint on academy invoice numbers, verify production holds no existing
-- duplicate (academy_profile_id, invoice_number) pairs — the index creation in
-- the follow-up migration would otherwise fail. Counts only, no row data.

DO $$
DECLARE
  v_acad_dup_pairs integer;
  v_acad_dup_rows integer;
  v_trainer_dup_pairs integer;
  v_no_owner integer;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(cnt), 0)
  INTO v_acad_dup_pairs, v_acad_dup_rows
  FROM (
    SELECT academy_profile_id, invoice_number, COUNT(*) AS cnt
    FROM public.invoices
    WHERE academy_profile_id IS NOT NULL
    GROUP BY academy_profile_id, invoice_number
    HAVING COUNT(*) > 1
  ) d;

  -- Should be zero already (existing UNIQUE(trainer_id, invoice_number)).
  SELECT COUNT(*)
  INTO v_trainer_dup_pairs
  FROM (
    SELECT trainer_id, invoice_number, COUNT(*) AS cnt
    FROM public.invoices
    WHERE trainer_id IS NOT NULL
    GROUP BY trainer_id, invoice_number
    HAVING COUNT(*) > 1
  ) d;

  SELECT COUNT(*)
  INTO v_no_owner
  FROM public.invoices
  WHERE trainer_id IS NULL AND academy_profile_id IS NULL;

  RAISE NOTICE 'M10-PRECHECK academy_dup_pairs=% academy_dup_rows=% trainer_dup_pairs=% no_owner_invoices=%',
    v_acad_dup_pairs, v_acad_dup_rows, v_trainer_dup_pairs, v_no_owner;
END $$;
