
-- Create player_links table for linking registrations that want to train together
CREATE TABLE public.player_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_group uuid NOT NULL DEFAULT gen_random_uuid(),
  intake_request_id uuid NOT NULL REFERENCES public.intake_requests(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intake_request_id)
);

ALTER TABLE public.player_links ENABLE ROW LEVEL SECURITY;

-- Trainers can manage links for their own cycles
CREATE POLICY "Trainers can manage player links for their cycles"
ON public.player_links
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.intake_requests ir
    JOIN public.cycles c ON c.id = ir.cycle_id
    JOIN public.trainer_profiles tp ON tp.id = c.owner_id AND c.owner_type = 'trainer'
    WHERE ir.id = player_links.intake_request_id
      AND tp.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.intake_requests ir
    JOIN public.cycles c ON c.id = ir.cycle_id
    JOIN public.trainer_profiles tp ON tp.id = c.owner_id AND c.owner_type = 'trainer'
    WHERE ir.id = player_links.intake_request_id
      AND tp.user_id = auth.uid()
  )
);

-- Academy managers can manage links for their academy's cycles
CREATE POLICY "Academy managers can manage player links"
ON public.player_links
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.intake_requests ir
    JOIN public.cycles c ON c.id = ir.cycle_id
    JOIN public.academy_managers am ON am.academy_profile_id = c.owner_id AND c.owner_type = 'academy'
    WHERE ir.id = player_links.intake_request_id
      AND am.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.intake_requests ir
    JOIN public.cycles c ON c.id = ir.cycle_id
    JOIN public.academy_managers am ON am.academy_profile_id = c.owner_id AND c.owner_type = 'academy'
    WHERE ir.id = player_links.intake_request_id
      AND am.user_id = auth.uid()
  )
);

-- Admins can manage all player links
CREATE POLICY "Admins can manage all player links"
ON public.player_links
FOR ALL
TO authenticated
USING (public.is_admin(auth.uid()))
WITH CHECK (public.is_admin(auth.uid()));
