-- M-10: invoice numbering integrity.
--
-- Problem: the only uniqueness constraint is UNIQUE(trainer_id, invoice_number).
-- Academy invoices carry trainer_id = NULL, and Postgres treats NULLs as
-- distinct, so academy invoice numbers had ZERO uniqueness — two admins (or two
-- trainers under one academy) could mint the same legal invoice number with
-- different amounts. Numbering was also a non-atomic read-increment-write with
-- the counter advanced AFTER insert, so concurrent creators could allocate the
-- same sequence.
--
-- Pre-flight (20260612120000) confirmed production has zero duplicate
-- (academy_profile_id, invoice_number) pairs, so the constraint is safe to add.

-- 1) Academy-scoped uniqueness, mirroring unique_invoice_number_per_trainer.
--    Applies to every academy-numbered invoice (manual: trainer_id NULL, and
--    auto-created academy-managed: both ids set). NULL academy_profile_id rows
--    (personal trainer invoices) are exempt, as intended.
ALTER TABLE public.invoices
  ADD CONSTRAINT unique_invoice_number_per_academy UNIQUE (academy_profile_id, invoice_number);

-- 2) Atomic sequence allocation. A single UPDATE ... RETURNING row-locks the
--    profile, so concurrent callers each get a distinct number — replacing the
--    read-increment-write in two clients and the edge function. p_min lets the
--    caller raise the floor to (max existing sequence + 1) when legacy invoice
--    numbers have drifted ahead of the stored counter; GREATEST applies it
--    atomically. The counter is advanced BEFORE the invoice insert: a failed
--    insert wastes a number (acceptable gap) instead of duplicating one.
CREATE OR REPLACE FUNCTION public.next_invoice_sequence(
  p_profile_type text,
  p_profile_id uuid,
  p_min integer DEFAULT 1
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allocated integer;
  v_caller uuid := auth.uid();
  v_authorized boolean := false;
BEGIN
  IF p_min IS NULL OR p_min < 1 THEN
    p_min := 1;
  END IF;

  -- Service-role/cron callers carry no auth.uid(); anon has no EXECUTE grant.
  IF v_caller IS NULL THEN
    v_authorized := true;
  ELSIF p_profile_type = 'trainer' THEN
    v_authorized := EXISTS (
      SELECT 1 FROM public.trainer_profiles tp
      WHERE tp.id = p_profile_id AND tp.user_id = v_caller
    );
  ELSIF p_profile_type = 'academy' THEN
    v_authorized := public.is_academy_manager(v_caller, p_profile_id);
  END IF;

  IF NOT v_authorized AND v_caller IS NOT NULL THEN
    v_authorized := EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_caller AND ur.role = 'admin'
    );
  END IF;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'next_invoice_sequence: not authorized for % profile %', p_profile_type, p_profile_id
      USING ERRCODE = '42501';
  END IF;

  IF p_profile_type = 'academy' THEN
    UPDATE public.academy_profiles
    SET invoice_next_number = GREATEST(COALESCE(invoice_next_number, 1), p_min) + 1
    WHERE id = p_profile_id
    RETURNING invoice_next_number - 1 INTO v_allocated;
  ELSIF p_profile_type = 'trainer' THEN
    UPDATE public.trainer_profiles
    SET invoice_next_number = GREATEST(COALESCE(invoice_next_number, 1), p_min) + 1
    WHERE id = p_profile_id
    RETURNING invoice_next_number - 1 INTO v_allocated;
  ELSE
    RAISE EXCEPTION 'next_invoice_sequence: unknown profile type "%"', p_profile_type;
  END IF;

  IF v_allocated IS NULL THEN
    RAISE EXCEPTION 'next_invoice_sequence: % profile % not found', p_profile_type, p_profile_id;
  END IF;

  RETURN v_allocated;
END;
$$;

REVOKE ALL ON FUNCTION public.next_invoice_sequence(text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.next_invoice_sequence(text, uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.next_invoice_sequence(text, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.next_invoice_sequence(text, uuid, integer) TO service_role;
