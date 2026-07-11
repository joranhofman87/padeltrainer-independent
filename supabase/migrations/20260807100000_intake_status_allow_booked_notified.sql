-- ============================================================================
-- Fix: intake_requests.status CHECK never gained 'booked' or 'notified'
-- ============================================================================
-- The status CHECK (defined inline in 20260123104639, never widened) allows only
--   ('new','proposed','confirmed','rejected','waitlist')
-- but the registration proposal workflow writes two more values that the CHECK rejects:
--   • finalize_cycle_proposals (the "Approve & Book all" RPC, 20260701120000) sets status='booked'
--   • send-schedule-notifications sets status='notified'
-- so the "Approve & Book all" step raises a check_violation and the whole transaction rolls back —
-- the registration finalize/notify flow CANNOT complete in production. Confirmed against prod
-- (2026-07-11): 85 intakes stuck at 'proposed', ZERO ever reaching 'booked'. This is the schema
-- drift the architecture audit flagged (docs/audits/ARCHITECTURE_AUDIT_2026-07-11.md, §3.5 / Theme 3),
-- and it also means any environment rebuilt from migrations already matches prod (both reject 'booked').
--
-- FIX: widen the CHECK to the full committed vocabulary. Both new values are first-class, intended
-- states — get_academy_cyclus_groups already filters intake status IN ('confirmed','booked','pending').
-- The drop is name-agnostic (the original is an inline auto-named constraint) so it works regardless of
-- the exact constraint name; the ADD re-validates all existing rows, which are all in the allowed set.
-- ============================================================================

DO $$
DECLARE c text;
BEGIN
  -- Drop whatever CHECK currently constrains intake_requests.status (match by definition, not name,
  -- since an inline column CHECK is auto-named and could differ across environments).
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.intake_requests'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
      AND pg_get_constraintdef(oid) ILIKE '%waitlist%'
  LOOP
    EXECUTE format('ALTER TABLE public.intake_requests DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE public.intake_requests
  ADD CONSTRAINT intake_requests_status_check
  CHECK (status IN ('new', 'proposed', 'confirmed', 'rejected', 'waitlist', 'booked', 'notified'));
