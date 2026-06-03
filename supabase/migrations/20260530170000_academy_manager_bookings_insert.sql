-- Allow academy managers to enroll guest players when creating academy cycles.
-- Trainers and self-service player bookings are unchanged (separate INSERT policies).

CREATE POLICY "Academy managers can create bookings for academy slots"
ON public.bookings
FOR INSERT
TO authenticated
WITH CHECK (
  guest_player_id IS NOT NULL
  AND player_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.availability_slots s
    WHERE s.id = slot_id
      AND s.academy_profile_id IS NOT NULL
      AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
      AND (
        EXISTS (
          SELECT 1
          FROM public.guest_players gp
          WHERE gp.id = guest_player_id
            AND gp.academy_profile_id = s.academy_profile_id
        )
        OR EXISTS (
          SELECT 1
          FROM public.guest_players gp
          JOIN public.academy_trainers at
            ON at.trainer_profile_id = gp.trainer_id
          WHERE gp.id = guest_player_id
            AND gp.trainer_id IS NOT NULL
            AND at.academy_profile_id = s.academy_profile_id
            AND at.status = 'active'
        )
      )
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
      AND policyname = 'Academy managers can create bookings for academy slots'
  ) THEN
    RAISE EXCEPTION 'bookings INSERT policy "Academy managers can create bookings for academy slots" missing';
  END IF;
END $$;
