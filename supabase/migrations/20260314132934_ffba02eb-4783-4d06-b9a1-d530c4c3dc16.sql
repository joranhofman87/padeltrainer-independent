CREATE POLICY "Academy managers can view their trainers profiles"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  user_id IN (
    SELECT tp.user_id
    FROM trainer_profiles tp
    JOIN academy_trainers at ON at.trainer_profile_id = tp.id
    JOIN academy_managers am ON am.academy_profile_id = at.academy_profile_id
    WHERE am.user_id = auth.uid()
      AND at.status = 'active'
  )
);