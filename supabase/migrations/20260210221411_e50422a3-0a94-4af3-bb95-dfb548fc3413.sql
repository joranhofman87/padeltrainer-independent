
-- Allow academy managers to SELECT guest_players for their academy's trainers
CREATE POLICY "Academy managers can view their trainers guest players"
ON public.guest_players FOR SELECT
USING (
  trainer_id IN (
    SELECT at.trainer_profile_id
    FROM academy_trainers at
    WHERE at.status = 'active'
      AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
  )
);

-- Allow academy managers to INSERT guest_players for their academy's trainers
CREATE POLICY "Academy managers can create guest players for their trainers"
ON public.guest_players FOR INSERT
WITH CHECK (
  trainer_id IN (
    SELECT at.trainer_profile_id
    FROM academy_trainers at
    WHERE at.status = 'active'
      AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
  )
);

-- Allow academy managers to UPDATE guest_players for their academy's trainers
CREATE POLICY "Academy managers can update their trainers guest players"
ON public.guest_players FOR UPDATE
USING (
  trainer_id IN (
    SELECT at.trainer_profile_id
    FROM academy_trainers at
    WHERE at.status = 'active'
      AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
  )
);

-- Allow academy managers to DELETE guest_players for their academy's trainers
CREATE POLICY "Academy managers can delete their trainers guest players"
ON public.guest_players FOR DELETE
USING (
  trainer_id IN (
    SELECT at.trainer_profile_id
    FROM academy_trainers at
    WHERE at.status = 'active'
      AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
  )
);
