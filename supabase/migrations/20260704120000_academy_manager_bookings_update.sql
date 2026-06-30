-- Academy managers could SELECT and INSERT bookings on their academy's slots, but had NO UPDATE
-- policy. So removing a player from a cycle (soft-cancel: status='cancelled') and the roster swap
-- (reassign guest_player_id) were SILENTLY rejected by RLS — 0 rows changed, no error — while the
-- UI reported success from the SELECT row count. Adds the missing UPDATE policy, scoped to the
-- manager's academy slots exactly like the existing INSERT policy (20260530170000).
--
-- Academy managers are the billing authority for their academy, so updating bookings on their own
-- slots (cancel, reassign, mark paid) is intended; the financial-tamper trigger still blocks
-- PLAYERS from self-mutating money/workflow columns.

CREATE POLICY "Academy managers can update bookings for academy slots"
ON public.bookings
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.availability_slots s
    WHERE s.id = bookings.slot_id
      AND s.academy_profile_id IS NOT NULL
      AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
  )
)
WITH CHECK (
  -- The booking must STAY on a slot in the manager's academy (can't move it elsewhere).
  EXISTS (
    SELECT 1
    FROM public.availability_slots s
    WHERE s.id = bookings.slot_id
      AND s.academy_profile_id IS NOT NULL
      AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
  )
);

-- Assert policy is installed (no data mutation)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'bookings'
      AND policyname = 'Academy managers can update bookings for academy slots'
  ) THEN
    RAISE EXCEPTION 'bookings UPDATE policy "Academy managers can update bookings for academy slots" missing';
  END IF;
END $$;
