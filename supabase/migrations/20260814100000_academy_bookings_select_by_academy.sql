-- ============================================================================
-- Academy bookings SELECT: scope by academy_profile_id, not active-trainer (audit Batch 5, §4.5 P1)
-- ============================================================================
-- The academy-manager bookings SELECT policy (20260325192818) scoped by the ACADEMY'S ACTIVE TRAINER
-- membership: bookings on slots whose `trainer_id` is an `academy_trainers` row with status='active'.
-- The academy-manager INSERT (20260530170000) + UPDATE (20260704120000) policies, by contrast, scope
-- by the slot's own `academy_profile_id`. That mismatch caused two bugs on the SELECT side:
--   • [P1] A DEPARTED trainer's bookings vanished from the academy's reports RETROACTIVELY — the
--     instant their membership went inactive, every booking on their (still academy-owned) slots
--     dropped out of the manager's view.
--   • A trainer active in TWO academies leaked: their OTHER academy's slot bookings satisfied the
--     `trainer_id IN active_trainers` test for THIS academy's manager (same class as get_academy_
--     cyclus_groups, #497).
--
-- Fix: re-create the SELECT policy with the SAME `academy_profile_id` boundary the write policies use.
-- A manager sees exactly the bookings on their academy's slots — regardless of the trainer's current
-- membership, and never another academy's. (Academy slots always carry academy_profile_id; the INSERT
-- policy already requires it, so this neither widens nor strands legitimate academy bookings.)
-- ============================================================================

DROP POLICY IF EXISTS "Academy managers can view bookings for their trainers slots" ON public.bookings;

CREATE POLICY "Academy managers can view bookings for their trainers slots"
ON public.bookings FOR SELECT
TO authenticated
USING (
  slot_id IN (
    SELECT s.id FROM public.availability_slots s
    WHERE s.academy_profile_id IS NOT NULL
      AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
  )
);

-- Assert the policy is installed (no data mutation).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'bookings'
      AND policyname = 'Academy managers can view bookings for their trainers slots'
  ) THEN
    RAISE EXCEPTION 'bookings SELECT policy "Academy managers can view bookings for their trainers slots" missing';
  END IF;
END $$;
