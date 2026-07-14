-- ============================================================================
-- Registration ↔ cycle decoupling — RLS + counts repoint (owner authz by form)
-- ============================================================================
-- Once cycle_id is "planned into" (nullable) and a form has no cycle shell, the intake_requests
-- owner policies + counts — all keyed on cycle_id → cycles.owner — would DENY a trainer access to
-- their own registrants (cycle_id is NULL). Repoint owner authorization to the registration form.
-- SECURITY-CRITICAL: this governs cross-tenant access to applicant PII (see the isolation rehearsal
-- src/test/registrationIntakeRls.pglite.test.ts).

-- Does the current user (auth.uid()) own the form this intake belongs to? Reuses the existing
-- trainer/academy/club authz helper, so there is ONE definition of "owns a registration".
CREATE OR REPLACE FUNCTION public.user_owns_registration(_registration_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.registrations r
    WHERE r.id = _registration_id
      AND public._registration_owner_authorized(r.owner_type, r.owner_id)
  );
$$;

-- Drop the 12 cycle_id-based owner policies (trainer/academy/club × CRUD).
DROP POLICY IF EXISTS "Trainers can create intake requests for their cycles" ON public.intake_requests;
DROP POLICY IF EXISTS "Trainers can view intake requests for their cycles" ON public.intake_requests;
DROP POLICY IF EXISTS "Trainers can update intake requests for their cycles" ON public.intake_requests;
DROP POLICY IF EXISTS "Trainers can delete intake requests for their cycles" ON public.intake_requests;
DROP POLICY IF EXISTS "Academy managers can create intake requests for academy cycles" ON public.intake_requests;
DROP POLICY IF EXISTS "Academy managers can view intake requests" ON public.intake_requests;
DROP POLICY IF EXISTS "Academy managers can update intake requests" ON public.intake_requests;
DROP POLICY IF EXISTS "Academy managers can delete intake requests" ON public.intake_requests;
DROP POLICY IF EXISTS "Club managers can create intake requests for club cycles" ON public.intake_requests;
DROP POLICY IF EXISTS "Club managers can view intake requests for club cycles" ON public.intake_requests;
DROP POLICY IF EXISTS "Club managers can update intake requests for club cycles" ON public.intake_requests;
DROP POLICY IF EXISTS "Club managers can delete intake requests for club cycles" ON public.intake_requests;

-- One owner policy per command, keyed on the registration form's owner (trainer/academy/club all
-- handled by the shared helper). Player self-service + service_role policies are unchanged.
CREATE POLICY "Owners view their registration intakes" ON public.intake_requests
  FOR SELECT USING (public.user_owns_registration(registration_id));
CREATE POLICY "Owners create their registration intakes" ON public.intake_requests
  FOR INSERT WITH CHECK (public.user_owns_registration(registration_id));
CREATE POLICY "Owners update their registration intakes" ON public.intake_requests
  FOR UPDATE USING (public.user_owns_registration(registration_id))
  WITH CHECK (public.user_owns_registration(registration_id));
CREATE POLICY "Owners delete their registration intakes" ON public.intake_requests
  FOR DELETE USING (public.user_owns_registration(registration_id));

-- Per-registration intake counts (replaces count_cycles_intakes, keyed on the now-nullable cycle_id).
-- SECURITY INVOKER → RLS-scoped, same as the function it replaces.
CREATE OR REPLACE FUNCTION public.count_registrations_intakes(_registration_ids uuid[])
RETURNS TABLE(registration_id uuid, n bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT ir.registration_id, count(*)::bigint AS n
  FROM public.intake_requests ir
  WHERE ir.registration_id = ANY(_registration_ids)
  GROUP BY ir.registration_id;
$$;

GRANT EXECUTE ON FUNCTION public.user_owns_registration(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_registrations_intakes(uuid[]) TO authenticated;
