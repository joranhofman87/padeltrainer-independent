-- Add RLS policies for academy managers to manage trainer profiles in their academy

-- UPDATE policy: Allow academy managers to update trainer profiles for trainers in their academy
CREATE POLICY "Academy managers can update trainer profiles in their academy"
  ON public.trainer_profiles FOR UPDATE
  USING (
    id IN (
      SELECT at.trainer_profile_id
      FROM academy_trainers at
      WHERE at.status = 'active'
        AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
    )
  );

-- SELECT policy: Allow academy managers to view trainer profiles for trainers in their academy
CREATE POLICY "Academy managers can view trainer profiles in their academy"
  ON public.trainer_profiles FOR SELECT
  USING (
    id IN (
      SELECT at.trainer_profile_id
      FROM academy_trainers at
      WHERE at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
    )
  );