
CREATE POLICY "Academy managers can view bookings for their trainers slots"
ON public.bookings FOR SELECT
TO authenticated
USING (
  slot_id IN (
    SELECT s.id FROM availability_slots s
    WHERE s.trainer_id IN (
      SELECT at.trainer_profile_id FROM academy_trainers at
      WHERE at.status = 'active'
      AND at.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
    )
  )
);

CREATE POLICY "Academy managers can view guest players for their trainers"
ON public.guest_players FOR SELECT
TO authenticated
USING (
  trainer_id IN (
    SELECT at.trainer_profile_id FROM academy_trainers at
    WHERE at.status = 'active'
    AND at.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
  )
  OR
  academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
);
