-- Add missing INSERT policy for academy managers
CREATE POLICY "Academy managers can create intake requests for academy cycles"
ON public.intake_requests
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM cycles c
    JOIN academy_managers am ON am.academy_profile_id = c.owner_id
    WHERE c.id = intake_requests.cycle_id
      AND c.owner_type = 'academy'
      AND am.user_id = auth.uid()
  )
);

-- Add missing INSERT policy for trainers
CREATE POLICY "Trainers can create intake requests for their cycles"
ON public.intake_requests
FOR INSERT
TO authenticated
WITH CHECK (
  cycle_id IN (
    SELECT c.id FROM cycles c
    WHERE c.owner_type = 'trainer'
      AND c.owner_id IN (
        SELECT tp.id FROM trainer_profiles tp WHERE tp.user_id = auth.uid()
      )
  )
);