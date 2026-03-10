-- Add RLS policies for academy managers to manage intake_requests for their academy cycles

-- Academy managers can view intake requests for their academy's cycles
CREATE POLICY "Academy managers can view intake requests"
ON public.intake_requests
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.cycles c
    JOIN public.academy_managers am ON am.academy_profile_id = c.owner_id
    WHERE c.id = intake_requests.cycle_id
      AND c.owner_type = 'academy'
      AND am.user_id = auth.uid()
  )
);

-- Academy managers can update intake requests for their academy's cycles
CREATE POLICY "Academy managers can update intake requests"
ON public.intake_requests
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.cycles c
    JOIN public.academy_managers am ON am.academy_profile_id = c.owner_id
    WHERE c.id = intake_requests.cycle_id
      AND c.owner_type = 'academy'
      AND am.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.cycles c
    JOIN public.academy_managers am ON am.academy_profile_id = c.owner_id
    WHERE c.id = intake_requests.cycle_id
      AND c.owner_type = 'academy'
      AND am.user_id = auth.uid()
  )
);

-- Academy managers can delete intake requests for their academy's cycles
CREATE POLICY "Academy managers can delete intake requests"
ON public.intake_requests
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.cycles c
    JOIN public.academy_managers am ON am.academy_profile_id = c.owner_id
    WHERE c.id = intake_requests.cycle_id
      AND c.owner_type = 'academy'
      AND am.user_id = auth.uid()
  )
);