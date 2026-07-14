-- ============================================================================
-- Registration ↔ cycle decoupling — Phase 2a: canonical intake→registration link
-- ============================================================================
-- Goal (see docs/REGISTRATION_DECOUPLE_PLAN.md): make intake_requests.registration_id
-- the CANONICAL "which form" link, reliably populated for every existing and future row,
-- so later steps can treat the registration as the source of truth and let cycle_id become
-- "the training cycle this registrant was planned into" (nullable, NULL until planned).
--
-- Today intakes link to a form via cycle_id (the cycles shell). registration_id was added
-- (20260628100000) but NOTHING populates it on insert — 15 rows are NULL and new submits leave
-- it NULL. This step derives it automatically, backfills, and enforces it. Non-destructive:
-- no user-facing behaviour changes; it only fills + enforces a column.

-- 1. Auto-derive registration_id from the form's overlay on insert when not explicitly set.
--    Safe bridge across the transition: current submit paths set only cycle_id → the trigger
--    fills registration_id; a later step sets registration_id directly and may leave cycle_id
--    NULL → the guard skips both cases. SECURITY DEFINER so it reads registrations under RLS.
CREATE OR REPLACE FUNCTION public.derive_intake_registration_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.registration_id IS NULL AND NEW.cycle_id IS NOT NULL THEN
    SELECT r.id INTO NEW.registration_id
      FROM public.registrations r
      WHERE r.source_cycle_id = NEW.cycle_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_derive_intake_registration_id ON public.intake_requests;
CREATE TRIGGER trg_derive_intake_registration_id
  BEFORE INSERT ON public.intake_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.derive_intake_registration_id();

-- 2. Backfill existing rows (the 15 NULLs; idempotent for the rest).
UPDATE public.intake_requests ir
SET registration_id = r.id
FROM public.registrations r
WHERE ir.registration_id IS NULL
  AND r.source_cycle_id = ir.cycle_id;

-- 3. registration_id NOT NULL is incompatible with ON DELETE SET NULL — a form's intakes belong
--    to the form, so cascade them when the form is hard-deleted (matches registrations→cycles).
--    Invoices are referenced by id, not owned here, so they are not deleted by this.
ALTER TABLE public.intake_requests
  DROP CONSTRAINT IF EXISTS intake_requests_registration_id_fkey;
ALTER TABLE public.intake_requests
  ADD CONSTRAINT intake_requests_registration_id_fkey
  FOREIGN KEY (registration_id) REFERENCES public.registrations(id) ON DELETE CASCADE;

-- 4. Enforce the canonical link. Fails loudly if any row is still unlinked (the safety net —
--    every registration/event form currently has an overlay row, so this holds).
ALTER TABLE public.intake_requests
  ALTER COLUMN registration_id SET NOT NULL;

-- 5. Mirror the existing (cycle_id, player_id) one-application-per-form guard onto the canonical
--    link so it survives when cycle_id becomes nullable. NULL player_id (guest intakes) stay
--    un-deduped here exactly as before — email rate-limiting guards those.
CREATE UNIQUE INDEX IF NOT EXISTS uq_intake_requests_registration_player
  ON public.intake_requests (registration_id, player_id);
