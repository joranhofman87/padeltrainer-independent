-- ============================================================================
-- Guard: an intake_requests row may only target a REGISTRATION / EVENT cycle
-- ============================================================================
-- intake_requests.cycle_id is a plain FK with no type condition, so every insert path can attach a
-- sign-up to ANY cycle — a training cyclus or a live rebook round (both status='open' and
-- form-renderable by URL) — producing phantom "registrations" on a training container that then
-- surface as ghost players in the academy overview (architecture audit 2026-07-11, Themes 2/5; V1/V3).
--
-- PRs #479 added edge-function pre-checks to submit-guest-intake (guest path) and refused proposals on
-- non-registration cycles. This trigger is the ENFORCED-BY-CONSTRUCTION backstop covering the paths
-- the edge guards don't: the authenticated self-register (submitIntakeRequest, a client insert under
-- RLS) and the manual staff add (createManualIntakeRequest). A "registration form" is a cycle with a
-- `registrations` overlay row (the split model: shell born type='cyclus' + overlay) OR a legacy
-- type='registration'/'event' cycle. Every legitimate intake targets one of those, so valid flows are
-- unaffected; only a genuine training cyclus / rebook round is rejected.
--
-- BEFORE INSERT only — existing rows are untouched (the 205 'new' + 85 'proposed' prod rows already
-- target registration forms). finalize_cycle_proposals UPDATEs status and is not affected.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_intake_target_is_registration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.cycles c
    WHERE c.id = NEW.cycle_id
      AND (
        c.type IN ('registration', 'event')
        OR EXISTS (SELECT 1 FROM public.registrations r WHERE r.source_cycle_id = c.id)
      )
  ) THEN
    RAISE EXCEPTION 'intake_requests may only target a registration or event cycle (cycle_id=%)', NEW.cycle_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_intake_target_is_registration ON public.intake_requests;
CREATE TRIGGER trg_intake_target_is_registration
  BEFORE INSERT ON public.intake_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_intake_target_is_registration();
