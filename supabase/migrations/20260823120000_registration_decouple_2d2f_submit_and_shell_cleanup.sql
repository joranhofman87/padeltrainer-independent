-- ============================================================================
-- Registration ↔ cycle decoupling — Phase 2d + 2f: submit path + shell cleanup
-- ============================================================================
-- After 2a (canonical intake.registration_id) and 2c (standalone form writes), this step
-- severs the last live use of the cycle shell for a registration:
--   * intake_requests.cycle_id becomes "the training cycle a registrant was PLANNED into"
--     (nullable, NULL until planned) instead of "which form".
--   * the intake-target guard validates the registration, not a cycle.
--   * events keep sign-up payments via a new invoices.registration_id anchor (registrations are
--     free; only format='event' invoices).
--   * the 10 existing (all UNPLANNED — 0 slots/0 bookings) cycle shells are detached + deleted;
--     their intakes/invoices are repointed to the registration first so nothing is lost.
-- See docs/REGISTRATION_DECOUPLE_PLAN.md.

-- ----------------------------------------------------------------------------
-- 2f-pre: give invoices a registration anchor (events that charge at sign-up)
-- ----------------------------------------------------------------------------
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS registration_id uuid REFERENCES public.registrations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_registration_id ON public.invoices (registration_id);

-- Backfill: any invoice currently anchored to a form's cycle shell → point at the form.
UPDATE public.invoices i
SET registration_id = r.id
FROM public.registrations r
WHERE i.registration_id IS NULL
  AND r.source_cycle_id IS NOT NULL
  AND i.cycle_id = r.source_cycle_id;

-- ----------------------------------------------------------------------------
-- 2d: cycle_id becomes "planned into" (nullable); guard validates the registration
-- ----------------------------------------------------------------------------
ALTER TABLE public.intake_requests ALTER COLUMN cycle_id DROP NOT NULL;

-- The intake-target guard now checks the CANONICAL link: registration_id must exist and be a
-- registration/event form. (Replaces enforce_intake_target_is_registration, which keyed on cycle_id
-- being a registration/event cycle — obsolete once forms have no cycle shell.) The 2a derive-trigger
-- still fills registration_id from cycle_id for any legacy caller that sends only cycle_id.
CREATE OR REPLACE FUNCTION public.enforce_intake_target_is_registration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.registration_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.registrations r WHERE r.id = NEW.registration_id) THEN
    RAISE EXCEPTION 'intake_requests must target a registration form (registration_id=%)', NEW.registration_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- The derive-trigger (2a) is BEFORE INSERT and fills registration_id from cycle_id; the guard must
-- run AFTER it. Both are BEFORE INSERT row triggers → they fire in alphabetical name order:
-- trg_derive_intake_registration_id (d) < trg_intake_target_is_registration (i). Order holds.

-- ----------------------------------------------------------------------------
-- 2f: detach + delete the empty cycle shells
-- ----------------------------------------------------------------------------
-- source_cycle_id stops being a live FK to cycles and becomes a LEGACY-URL ALIAS: distributed
-- /register/:sourceCycleId links + QR codes resolve via getRegistration matching source_cycle_id,
-- so the value must survive the shell's deletion. Drop the FK (keep the value + the unique index).
ALTER TABLE public.registrations DROP CONSTRAINT IF EXISTS registrations_source_cycle_id_fkey;

-- Guard: only delete shells that are genuinely unplanned. A shell with any slot or booking is NOT
-- deleted (defensive — there are none today, but never destroy a planned cycle).
DO $$
DECLARE
  v_shell record;
BEGIN
  FOR v_shell IN
    SELECT r.id AS reg_id, r.source_cycle_id AS cycle_id
    FROM public.registrations r
    WHERE r.source_cycle_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.availability_slots s WHERE s.cyclus_id = r.source_cycle_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.bookings b
        JOIN public.availability_slots s ON s.id = b.slot_id
        WHERE s.cyclus_id = r.source_cycle_id
      )
  LOOP
    -- Repoint intakes off the shell: they already carry registration_id (2a); NULL their cycle_id
    -- (= "not planned into a training cycle yet") so the shell delete (intake.cycle_id → CASCADE)
    -- cannot take them.
    UPDATE public.intake_requests SET cycle_id = NULL WHERE cycle_id = v_shell.cycle_id;
    -- Invoices already repointed to registration_id above; NULL cycle_id (SET-NULL FK would do this
    -- on delete anyway) so nothing references the shell.
    UPDATE public.invoices SET cycle_id = NULL WHERE cycle_id = v_shell.cycle_id;
    -- source_cycle_id is KEPT on the registration as the legacy-URL alias (FK already dropped), so
    -- deleting the shell leaves a dangling-but-intentional alias value.
    DELETE FROM public.cycles WHERE id = v_shell.cycle_id;
  END LOOP;
END $$;
